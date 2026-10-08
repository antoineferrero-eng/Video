import { spawn } from 'node:child_process';
import type { SubtitleSync, SubtitleSyncResult, SubtitleSyncState } from '@lumiere/shared';
import { BadRequestError, ServiceUnavailableError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import type { KeyValueCache } from '../../infra/database/database';
import { languageLabel } from '../../domain/media-files';
import type { Ffmpeg } from './ffmpeg';
import { remoteInputArgs } from './ffmpeg-args';
import type { PlaybackService } from './playback.service';
import type { PlaybackSessionState, SubtitleSource } from './sessions';
import {
  FRAME_RATE_RATIOS,
  align,
  cueActivity,
  isReliable,
  parseCueTimes,
  speechActivity,
  type Interval,
  type ReferenceWindow,
} from './subtitle-alignment';

/** Recalage gardé longtemps : il vaut pour ce fichier et cette piste. */
const SYNC_TTL_MS = 400 * 24 * 3600_000;
/** Échec du recalage automatique : pas relancé d'office avant une semaine. */
const FAILED_TTL_MS = 7 * 24 * 3600_000;
const SAMPLE_RATE = 8000;
/** Extraits de l'audio écoutés pour un fichier distant : au plus ~200 Mo lus en tout. */
const REMOTE_READ_BUDGET = 200 * 1024 * 1024;
const EXCERPTS = 4;
const EXCERPT_POSITIONS = [0.12, 0.37, 0.62, 0.87];
const MIN_EXCERPT_S = 20;
const MAX_EXCERPT_S = 60;
const EXCERPT_TIMEOUT_MS = 120_000;
/** Un recalage plus petit que ça n'est pas signalé (sous-titres déjà calés). */
const NOTICEABLE_S = 0.15;

/**
 * Recalage des sous-titres : réglage manuel gardé par fichier et par piste, et recalage
 * automatique (voir subtitle-alignment.ts) sur une piste de référence déjà calée si on peut
 * l'obtenir sans rien télécharger (piste intégrée d'un fichier local ou déjà extraite,
 * sous-titres faits pour ce fichier précis), sinon sur la voix, dans quelques extraits
 * répartis dans le film.
 */
export class SubtitleSyncService {
  private readonly running = new Map<string, Promise<SubtitleSyncResult>>();

  constructor(
    private readonly playback: PlaybackService,
    private readonly ffmpeg: Ffmpeg,
    private readonly cache: KeyValueCache,
    private readonly userAgent: string,
    private readonly logger: Logger,
  ) {}

  private key(session: PlaybackSessionState, trackId: string): string {
    return `subsync:${session.mediaKey}:${trackId}`;
  }

  state(sessionId: string, trackId: string): SubtitleSyncState {
    const key = this.key(this.playback.session(sessionId), trackId);
    return {
      sync: this.cache.get<SubtitleSync>(key),
      autoFailed: this.cache.get<boolean>(`${key}:failed`) === true,
    };
  }

  save(sessionId: string, trackId: string, value: { offset: number; rate: number }): SubtitleSync {
    const sync: SubtitleSync = {
      offset: Math.round(value.offset * 1000) / 1000,
      rate: value.rate,
      source: 'manual',
      note: null,
    };
    this.cache.set(this.key(this.playback.session(sessionId), trackId), sync, SYNC_TTL_MS);
    return sync;
  }

  reset(sessionId: string, trackId: string): void {
    const key = this.key(this.playback.session(sessionId), trackId);
    this.cache.delete(key);
    this.cache.delete(`${key}:failed`);
  }

  /** Recalage automatique (une seule recherche à la fois par piste). */
  auto(sessionId: string, trackId: string): Promise<SubtitleSyncResult> {
    const id = `${sessionId}:${trackId}`;
    let pending = this.running.get(id);
    if (!pending) {
      pending = this.runAuto(sessionId, trackId).finally(() => this.running.delete(id));
      this.running.set(id, pending);
    }
    return pending;
  }

  private async runAuto(sessionId: string, trackId: string): Promise<SubtitleSyncResult> {
    const session = this.playback.session(sessionId);
    const track = this.playback.subtitleTrack(sessionId, trackId);
    if (!track) throw new BadRequestError('Piste de sous-titres introuvable.');
    const cues = parseCueTimes(await this.playback.subtitles(sessionId, trackId));
    if (cues.length < 20)
      return { sync: null, message: 'Trop peu de répliques pour recaler ces sous-titres.' };

    const expectedRate = this.expectedRate(session, track);
    const reference = await this.subtitleReference(sessionId, session, trackId);
    const windows = reference?.windows ?? (await this.voice(session, cues));
    const note = reference?.note ?? 'la voix';
    const alignment = align(windows, cues, { expectedRate });
    const key = this.key(session, trackId);
    this.logger.info(
      {
        session: session.id,
        track: trackId,
        on: note,
        rate: alignment?.rate,
        offset: alignment?.offset,
        confidence: alignment?.confidence.toFixed(1),
        agreement: alignment?.agreement.toFixed(2),
      },
      'Recalage automatique des sous-titres',
    );
    if (!isReliable(alignment)) {
      this.cache.set(`${key}:failed`, true, FAILED_TTL_MS);
      return {
        sync: null,
        message:
          'Recalage automatique incertain : calez une réplique avec Maj+G (sous-titres en retard) ou Maj+H (en avance).',
      };
    }
    const sync: SubtitleSync = {
      offset: alignment.offset,
      rate: alignment.rate,
      source: 'auto',
      note: `calés sur ${note}`,
    };
    this.cache.set(key, sync, SYNC_TTL_MS);
    const changed = alignment.rate !== 1 || Math.abs(alignment.offset) >= NOTICEABLE_S;
    return {
      sync,
      message: changed ? describe(sync) : `Sous-titres déjà synchronisés (${sync.note}).`,
    };
  }

  /**
   * Vitesse probable d'après la cadence déclarée des sous-titres : seul l'écart entre 25 i/s
   * (accéléré à la télévision européenne) et 23,976 ou 24 i/s change la durée du film.
   */
  private expectedRate(session: PlaybackSessionState, track: SubtitleSource): number | null {
    const subtitleFps = track.online?.fps ?? null;
    const videoFps = session.plan.videoStream?.frameRate ?? null;
    if (!subtitleFps || !videoFps) return null;
    const ratio = subtitleFps / videoFps;
    const known = FRAME_RATE_RATIOS.find((candidate) => Math.abs(candidate - ratio) < 0.002);
    const speedup = Math.abs(subtitleFps - 25) < 0.1 || Math.abs(videoFps - 25) < 0.1;
    return known !== undefined && speedup ? known : null;
  }

  /** Piste de référence déjà calée, disponible sans rien télécharger. */
  private async subtitleReference(
    sessionId: string,
    session: PlaybackSessionState,
    trackId: string,
  ): Promise<{ windows: ReferenceWindow[]; note: string } | null> {
    const candidates = session.subtitles.filter(
      (track) =>
        track.id !== trackId &&
        track.supported &&
        !track.isForced &&
        (track.source === 'embedded' || track.online?.hashMatch === true),
    );
    let best: { cues: Interval[]; track: SubtitleSource } | null = null;
    for (const track of candidates) {
      const vtt = await this.playback.subtitlesIfAvailable(sessionId, track.id);
      const cues = vtt ? parseCueTimes(vtt) : [];
      if (cues.length >= 50 && (!best || cues.length > best.cues.length)) best = { cues, track };
    }
    if (!best) return null;
    const duration = Math.max(session.duration ?? 0, best.cues[best.cues.length - 1]![1] + 10);
    const language = languageLabel(best.track.language);
    return {
      windows: [{ start: 0, step: 0.01, values: cueActivity(best.cues, duration, 0.01) }],
      note:
        best.track.source === 'embedded'
          ? `la piste intégrée${language ? ` (${language.toLowerCase()})` : ''}`
          : 'les sous-titres faits pour ce fichier',
    };
  }

  /** Parole détectée dans quelques extraits de l'audio, là où les répliques sont nombreuses. */
  private async voice(session: PlaybackSessionState, cues: Interval[]): Promise<ReferenceWindow[]> {
    if (!this.ffmpeg.info.available)
      throw new ServiceUnavailableError(
        'FFMPEG_UNAVAILABLE',
        'ffmpeg est nécessaire pour recaler les sous-titres.',
      );
    const audio = session.plan.audioStream ?? session.plan.audioStreams[0] ?? null;
    if (!audio) return [];
    const duration = session.duration ?? cues[cues.length - 1]![1];
    const bytesPerSecond = session.size && duration > 0 ? session.size / duration : 1_000_000;
    const length = session.isRemote
      ? Math.max(
          MIN_EXCERPT_S,
          Math.min(MAX_EXCERPT_S, REMOTE_READ_BUDGET / EXCERPTS / bytesPerSecond),
        )
      : MAX_EXCERPT_S;
    const starts = excerptStarts(cues, duration, length);
    // Voie centrale (dialogues) d'une piste multicanal ; bande de la voix.
    const filter = `${(audio.channels ?? 2) >= 5 ? 'pan=mono|c0=FC,' : ''}highpass=f=200,lowpass=f=3500`;
    const windows: ReferenceWindow[] = [];
    for (let index = 0; index < starts.length; index += 2) {
      const batch = await Promise.all(
        starts.slice(index, index + 2).map(async (start) => {
          try {
            const samples = await this.excerpt(session, audio.index, start, length, filter);
            return samples.length > SAMPLE_RATE * 5
              ? { start, step: 0.01, values: speechActivity(samples, SAMPLE_RATE) }
              : null;
          } catch (error) {
            this.logger.debug({ err: errorMessage(error), start }, 'Extrait audio indisponible');
            return null;
          }
        }),
      );
      for (const window of batch) if (window) windows.push(window);
    }
    return windows;
  }

  private excerpt(
    session: PlaybackSessionState,
    streamIndex: number,
    start: number,
    length: number,
    filter: string,
  ): Promise<Int16Array> {
    const args = [
      ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
      ...remoteInputArgs(session.isRemote, this.userAgent),
      ...['-ss', start.toFixed(3), '-i', session.input, '-t', String(Math.round(length))],
      ...['-map', `0:${streamIndex}`, '-af', filter, '-ac', '1', '-ar', String(SAMPLE_RATE)],
      ...['-f', 's16le', 'pipe:1'],
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg.ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let errors = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), EXCERPT_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (errors.length < 4000) errors += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        if (code !== 0 && data.length === 0) {
          reject(new Error(errors.trim().split('\n').at(-1) ?? `ffmpeg (${code})`));
          return;
        }
        // Copie alignée : un Buffer peut commencer à une adresse impaire.
        const samples = new Int16Array(Math.floor(data.length / 2));
        for (let index = 0; index < samples.length; index += 1)
          samples[index] = data.readInt16LE(index * 2);
        resolve(samples);
      });
    });
  }
}

/**
 * Début des extraits : un par quart du film environ, chacun placé là où les répliques sont
 * les plus denses à proximité (plus de parole, recalage plus sûr).
 */
export function excerptStarts(cues: Interval[], duration: number, length: number): number[] {
  const last = Math.max(0, duration - length);
  return EXCERPT_POSITIONS.map((position) => {
    const center = position * duration;
    const reach = duration * 0.1;
    let best = { start: Math.min(last, Math.max(0, center - length / 2)), covered: -1 };
    for (let start = center - reach; start <= center + reach; start += 10) {
      const from = Math.min(last, Math.max(0, start));
      let covered = 0;
      for (const [cueStart, cueEnd] of cues) {
        if (cueEnd <= from) continue;
        if (cueStart >= from + length) break;
        covered += Math.min(cueEnd, from + length) - Math.max(cueStart, from);
      }
      if (covered > best.covered) best = { start: from, covered };
    }
    return Math.round(best.start * 10) / 10;
  });
}

/** Message affiché après un recalage automatique. */
function describe(sync: SubtitleSync): string {
  const parts: string[] = [];
  if (Math.abs(sync.offset) >= 0.01) {
    const seconds = `${Math.abs(sync.offset).toFixed(1).replace('.', ',')} s`;
    parts.push(sync.offset > 0 ? `retardés de ${seconds}` : `avancés de ${seconds}`);
  }
  if (sync.rate !== 1) parts.push('cadence corrigée (autre version du film)');
  return `Sous-titres resynchronisés : ${parts.join(', ')} — ${sync.note}.`;
}
