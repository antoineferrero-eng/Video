import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import { errorMessage } from '../../core/errors';
import { fileSize } from '../../core/fs';
import { parseContentRangeStart, parseContentRangeTotal } from '../../core/http-range';
import type { Logger } from '../../core/logger';
import type { SourceResponse } from '../source/transport';
import { ByteRanges, type Span } from './byte-ranges';

/** Erreur de transfert, avec indication de reprise possible. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Refus d'une connexion supplémentaire par l'hôte (trop de connexions, plages ignorées…). */
class ConnectionRefused extends Error {
  constructor(readonly status: number) {
    super(`L'hôte refuse une connexion supplémentaire (${status}).`);
  }
}

/** Fichier où est noté ce qui a déjà été reçu (le `.part` a des trous). */
export function progressFile(partPath: string): string {
  return `${partPath}.json`;
}

export interface Tuning {
  /** Connexions simultanées au plus. */
  maxConnections: number;
  /** Taille minimale d'un morceau confié à une nouvelle connexion. */
  minSegment: number;
  /** Intervalle de mesure de la vitesse (ajout d'une connexion si elle progresse). */
  evaluateEveryMs: number;
  /** Gain de vitesse attendu d'une connexion de plus pour continuer d'en ajouter. */
  minGain: number;
  stallTimeoutMs: number;
  persistEveryMs: number;
}

const DEFAULT_TUNING: Tuning = {
  maxConnections: 6,
  minSegment: 8 * 1024 * 1024,
  evaluateEveryMs: 2_000,
  minGain: 1.15,
  stallTimeoutMs: 60_000,
  persistEveryMs: 2_000,
};

/** Statuts d'un hôte qui refuse une connexion de plus (ou le lien). */
const REFUSED = [401, 403, 404, 410, 429, 503];

export interface SegmentedTransferOptions {
  partPath: string;
  /**
   * Requête sur les octets [start, end[ (end null : jusqu'à la fin du fichier) ; `extra` :
   * connexion en plus de la première, qu'un refus ne doit pas faire insister.
   */
  open(
    start: number,
    end: number | null,
    signal: AbortSignal,
    extra: boolean,
  ): Promise<SourceResponse>;
  /** Taille du fichier distant (requête HEAD), quand une reprise est refusée (416). */
  remoteSize(signal: AbortSignal): Promise<number | null>;
  /** Avant d'écrire des octets reçus (limite de débit globale). */
  throttle(bytes: number, signal: AbortSignal): Promise<void>;
  /** Taille connue : contrôles avant d'écrire (espace disque…). */
  onTotal(total: number, remaining: number): Promise<void> | void;
  onProgress(downloaded: number, total: number | null): void;
  signal: AbortSignal;
  logger: Logger;
  /** Taille notée lors d'un essai précédent. */
  expectedTotal: number | null;
  tuning?: Partial<Tuning>;
}

/** Contenu du fichier de suivi (lu tel quel : à valider). */
interface SavedProgress {
  total?: unknown;
  ranges?: unknown;
}

interface Worker {
  id: number;
  /** Prochain octet à écrire, et fin (exclue) du morceau : elle recule si on le partage. */
  pos: number;
  end: number;
  controller: AbortController;
  lastDataAt: number;
}

/**
 * Télécharge un fichier en plusieurs morceaux simultanés (plages HTTP), comme les
 * gestionnaires de téléchargement : certains hôtes limitent le débit de chaque connexion,
 * ou servent lentement un fichier tant qu'il n'est pas dans leur cache.
 *
 * Une seule connexion au départ ; toutes les quelques secondes, une de plus tant que la
 * vitesse totale progresse nettement (6 au plus), chacune prenant la moitié restante du plus
 * gros morceau en cours. Un hôte qui refuse une connexion de plus (429, 503…) ou ignore les
 * plages ramène au nombre qui fonctionnait. Ce qui est reçu est noté à côté du `.part` :
 * une reprise ne redemande que les trous.
 */
export class SegmentedTransfer {
  private readonly tuning: Tuning;
  private ranges = new ByteRanges();
  private total: number | null;
  private file: FileHandle | null = null;
  private readonly workers = new Map<number, Worker>();
  private nextWorkerId = 0;
  private rangesSupported = false;
  private maxConnections: number;
  private growing = true;
  private received = 0;
  private measure = { at: 0, bytes: 0, connections: 0, skip: true };
  private readonly speeds = new Map<number, number>();
  private failure: unknown = null;
  private finished: (() => void) | null = null;
  private lastPersist = 0;
  private persisting: Promise<void> | null = null;

  constructor(private readonly options: SegmentedTransferOptions) {
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.maxConnections = this.tuning.maxConnections;
    this.total = options.expectedTotal;
  }

  /** Connexions ouvertes en ce moment. */
  get connections(): number {
    return this.workers.size;
  }

  async run(): Promise<{ total: number | null; downloaded: number }> {
    await this.load();
    if (this.complete()) return this.result();
    this.file = await fsp.open(this.options.partPath, fs.constants.O_RDWR | fs.constants.O_CREAT);
    const timers = [
      setInterval(() => this.evaluate(), this.tuning.evaluateEveryMs),
      setInterval(() => this.watchStalls(), Math.min(5_000, this.tuning.stallTimeoutMs / 2)),
    ];
    try {
      await this.transfer();
    } finally {
      for (const timer of timers) clearInterval(timer);
      for (const worker of this.workers.values()) worker.controller.abort();
      await this.persist(true);
      await this.file.close();
      this.file = null;
    }
    if (!this.complete()) throw new DownloadError('Transfert incomplet, reprise…', true);
    await fsp.rm(progressFile(this.options.partPath), { force: true });
    return this.result();
  }

  private result() {
    return { total: this.total, downloaded: this.ranges.size };
  }

  private complete(): boolean {
    return this.total !== null && this.ranges.size >= this.total;
  }

  // -------------------------------------------------------------------------
  // État enregistré
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const { partPath } = this.options;
    const size = await fileSize(partPath);
    if (size === null) {
      await fsp.rm(progressFile(partPath), { force: true });
      return;
    }
    const saved = await fsp
      .readFile(progressFile(partPath), 'utf8')
      .then((text) => JSON.parse(text) as SavedProgress | null)
      // Pas de suivi : `.part` d'un téléchargement d'un seul tenant (ou d'une version antérieure).
      .catch(() => null);
    if (saved && Array.isArray(saved.ranges)) {
      const spans = saved.ranges.filter(
        (span): span is Span =>
          Array.isArray(span) &&
          span.length === 2 &&
          span.every((value) => Number.isSafeInteger(value) && value >= 0),
      );
      this.ranges = new ByteRanges(spans);
      if (typeof saved.total === 'number' && saved.total > 0) this.total ??= saved.total;
    } else {
      this.ranges = new ByteRanges([[0, size]]);
    }
    this.ranges.clamp(size);
    if (this.total !== null && size > this.total) {
      await fsp.truncate(partPath, 0);
      this.ranges = new ByteRanges();
    }
    this.options.onProgress(this.ranges.size, this.total);
  }

  private async persist(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPersist < this.tuning.persistEveryMs) return;
    this.lastPersist = now;
    await this.persisting;
    const target = progressFile(this.options.partPath);
    const content = JSON.stringify({ total: this.total, ranges: this.ranges.toJSON() });
    this.persisting = fsp
      .writeFile(`${target}.tmp`, content)
      .then(() => fsp.rename(`${target}.tmp`, target))
      .catch((error: unknown) =>
        this.options.logger.debug({ err: errorMessage(error) }, 'Suivi du téléchargement'),
      );
    await this.persisting;
  }

  // -------------------------------------------------------------------------
  // Transfert
  // -------------------------------------------------------------------------

  private async transfer(): Promise<void> {
    const { signal } = this.options;
    const first = this.newWorker(this.ranges.firstMissing(0), Number.POSITIVE_INFINITY);
    const response = await this.options.open(
      first.pos,
      null,
      AbortSignal.any([signal, first.controller.signal]),
      false,
    );

    if (response.status === 416 && first.pos > 0) {
      await response.body?.cancel().catch(() => undefined);
      const remote = await this.options.remoteSize(signal);
      if (remote !== null && first.pos >= remote) {
        // Tout est déjà là (le fichier distant est plus court que la reprise demandée).
        await this.file?.truncate(remote);
        this.ranges.clamp(remote);
        this.total = remote;
        if (this.complete()) return;
      }
      await this.reset();
      throw new DownloadError('Reprise impossible : redémarrage depuis le début.', true);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404)
        throw new DownloadError('Fichier introuvable sur la source (404).', false);
      throw new DownloadError(
        `La source a répondu ${response.status}.`,
        response.status >= 500 || [403, 408, 425, 429].includes(response.status) || response.ok,
      );
    }

    const contentLength = Number(response.headers.get('content-length')) || null;
    const ranged =
      response.status === 206 &&
      parseContentRangeStart(response.headers.get('content-range')) === first.pos;
    if (!ranged && first.pos > 0) {
      // L'hôte ignore les plages : on repart de zéro, d'un seul tenant.
      await this.reset();
      first.pos = 0;
    }
    this.rangesSupported = ranged;
    this.total = ranged
      ? (parseContentRangeTotal(response.headers.get('content-range')) ??
        (contentLength !== null ? first.pos + contentLength : null))
      : contentLength;
    if (this.total !== null) {
      this.ranges.clamp(this.total);
      try {
        await this.options.onTotal(this.total, this.total - this.ranges.size);
      } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
      }
      first.end = this.ranges.nextCovered(first.pos) ?? this.total;
    }

    const done = new Promise<void>((resolve) => (this.finished = resolve));
    this.start(first, response);
    await done;
    if (this.failure) throw this.failure;
  }

  private async reset(): Promise<void> {
    await this.file?.truncate(0);
    this.ranges = new ByteRanges();
    this.options.onProgress(0, this.total);
  }

  private newWorker(pos: number, end: number): Worker {
    const worker: Worker = {
      id: this.nextWorkerId++,
      pos,
      end,
      controller: new AbortController(),
      lastDataAt: Date.now(),
    };
    return worker;
  }

  private start(worker: Worker, response: SourceResponse | null): void {
    this.workers.set(worker.id, worker);
    this.measure.skip = true;
    this.work(worker, response)
      .catch((error: unknown) => {
        if (this.failure) return;
        this.failure = error;
        for (const other of this.workers.values()) other.controller.abort();
      })
      .finally(() => {
        this.workers.delete(worker.id);
        this.measure.skip = true;
        if (this.workers.size === 0) this.finished?.();
      });
  }

  /** Une connexion : son morceau, puis tant qu'il reste du travail à prendre. */
  private async work(worker: Worker, initial: SourceResponse | null): Promise<void> {
    let response = initial;
    for (;;) {
      try {
        response ??= await this.openSegment(worker);
        await this.pump(worker, response);
      } catch (error) {
        if (this.options.signal.aborted || this.failure) throw error;
        if (error instanceof DownloadError && !error.retryable) throw error;
        const alone = this.workers.size === 1;
        if (error instanceof ConnectionRefused) {
          this.maxConnections = Math.max(1, this.workers.size - 1);
          this.growing = false;
          this.options.logger.info(
            { status: error.status, connections: this.maxConnections },
            'Connexion supplémentaire refusée : téléchargement ramené à moins de connexions',
          );
          if (alone)
            throw new DownloadError(`La source a répondu ${error.status}.`, error.status !== 404);
          return;
        }
        // Coupure : les autres connexions reprendront ce morceau ; seule, on laisse l'appelant
        // recommencer (avec temporisation) à partir de ce qui est déjà reçu.
        if (alone) throw error;
        this.options.logger.debug(
          { err: errorMessage(error) },
          'Connexion de téléchargement interrompue',
        );
        return;
      } finally {
        response = null;
      }
      if (!this.claim(worker)) return;
      worker.controller = new AbortController();
      worker.lastDataAt = Date.now();
    }
  }

  private async openSegment(worker: Worker): Promise<SourceResponse> {
    const response = await this.options.open(
      worker.pos,
      Number.isFinite(worker.end) ? worker.end : null,
      AbortSignal.any([this.options.signal, worker.controller.signal]),
      true,
    );
    const ranged =
      response.status === 206 &&
      parseContentRangeStart(response.headers.get('content-range')) === worker.pos;
    if (REFUSED.includes(response.status) || (response.ok && !ranged)) {
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) this.rangesSupported = false;
      throw new ConnectionRefused(response.status);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new DownloadError(`La source a répondu ${response.status}.`, true);
    }
    return response;
  }

  private async pump(worker: Worker, response: SourceResponse): Promise<void> {
    const file = this.file;
    const body = response.body;
    if (!file || !body) throw new DownloadError('Réponse vide.', true);
    const reader = body.getReader();
    try {
      while (worker.pos < worker.end) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.options.throttle(value.byteLength, worker.controller.signal);
        // Le morceau a pu être partagé entre-temps : on s'arrête à sa nouvelle fin.
        const length = Math.min(value.byteLength, worker.end - worker.pos);
        if (length <= 0) break;
        await file.write(value, 0, length, worker.pos);
        this.ranges.add(worker.pos, worker.pos + length);
        worker.pos += length;
        worker.lastDataAt = Date.now();
        this.received += length;
        this.options.onProgress(this.ranges.size, this.total);
        void this.persist();
      }
    } catch (error) {
      if (worker.controller.signal.aborted && !this.options.signal.aborted)
        throw worker.controller.signal.reason ?? error;
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!Number.isFinite(worker.end)) {
      // Taille inconnue : la fin du flux est la fin du fichier.
      this.total = worker.pos;
      worker.end = worker.pos;
      return;
    }
    if (worker.pos < worker.end) throw new DownloadError('Transfert incomplet, reprise…', true);
  }

  // -------------------------------------------------------------------------
  // Partage du travail
  // -------------------------------------------------------------------------

  /** Confie à `worker` un trou libre, sinon la moitié du plus gros morceau en cours. */
  private claim(worker: Worker): boolean {
    if (this.total === null || !this.rangesSupported) return false;
    const busy = [...this.workers.values()]
      .filter((other) => other !== worker && other.pos < other.end)
      .map((other): Span => [other.pos, other.end])
      .sort((a, b) => a[0] - b[0]);
    for (const gap of this.ranges.gaps(this.total)) {
      const free = subtract(gap, busy);
      if (free) {
        [worker.pos, worker.end] = free;
        return true;
      }
    }
    let largest: Worker | null = null;
    for (const other of this.workers.values()) {
      if (other === worker || !Number.isFinite(other.end)) continue;
      if (!largest || other.end - other.pos > largest.end - largest.pos) largest = other;
    }
    if (!largest || largest.end - largest.pos < 2 * this.tuning.minSegment) return false;
    const middle = largest.pos + Math.floor((largest.end - largest.pos) / 2);
    worker.pos = middle;
    worker.end = largest.end;
    largest.end = middle;
    return true;
  }

  /** Mesure la vitesse ; ajoute une connexion tant que la précédente l'a nettement augmentée. */
  private evaluate(): void {
    const now = Date.now();
    const { measure } = this;
    const connections = this.workers.size;
    const elapsed = (now - measure.at) / 1000;
    const speed = elapsed > 0 ? (this.received - measure.bytes) / elapsed : 0;
    const stable = !measure.skip && measure.connections === connections;
    this.measure = { at: now, bytes: this.received, connections, skip: false };
    if (!stable || connections === 0 || !this.growing || !this.rangesSupported) return;
    this.speeds.set(connections, speed);
    const before = this.speeds.get(connections - 1);
    if (before !== undefined && speed < before * this.tuning.minGain) {
      this.growing = false;
      this.options.logger.debug(
        { connections, speed: Math.round(speed) },
        'Téléchargement : une connexion de plus n’accélère plus',
      );
      return;
    }
    if (connections >= this.maxConnections) return;
    const worker = this.newWorker(0, 0);
    if (this.claim(worker)) this.start(worker, null);
  }

  private watchStalls(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (
        now - worker.lastDataAt > this.tuning.stallTimeoutMs &&
        !worker.controller.signal.aborted
      ) {
        worker.controller.abort(
          new DownloadError(
            `Transfert bloqué (aucune donnée reçue depuis ${Math.round(this.tuning.stallTimeoutMs / 1000)} s).`,
            true,
          ),
        );
      }
    }
  }
}

/** Première portion de `span` qui ne recoupe aucune des plages `busy` (triées). */
function subtract(span: Span, busy: Span[]): Span | null {
  let [start] = span;
  const end = span[1];
  for (const [busyStart, busyEnd] of busy) {
    if (busyEnd <= start) continue;
    if (busyStart >= end) break;
    if (busyStart > start) return [start, busyStart];
    start = Math.max(start, busyEnd);
    if (start >= end) return null;
  }
  return start < end ? [start, end] : null;
}
