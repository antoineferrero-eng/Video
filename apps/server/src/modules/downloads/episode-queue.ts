import { sleep } from '../../core/async';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { formatEpisodeCode } from '../../core/text';

/**
 * File des épisodes à demander à l'extension Stremio avant de les télécharger (saison ou
 * série entière). Les demandes partent une par une, espacées, pour respecter la limite de
 * requêtes de l'extension ; dès qu'elle signale sa limite de liens atteinte, le reste du lot
 * est abandonné (à relancer plus tard) plutôt que de vider la réserve en arrière-plan.
 */

export interface EpisodeTarget {
  season: number;
  episode: number;
}

/** Résultat d'un épisode : ajouté à la file, ou ignoré (avec la raison). */
export type EpisodeOutcome =
  { status: 'added'; limited: boolean } | { status: 'skipped'; reason: string; limited: boolean };

export interface BatchSummary {
  label: string;
  added: number;
  skipped: Array<{ code: string; reason: string }>;
  /** Épisodes non demandés : l'extension a atteint sa limite de liens. */
  abandoned: number;
}

interface Batch {
  titleId: number;
  label: string;
  remaining: number;
  added: number;
  skipped: Array<{ code: string; reason: string }>;
  abandoned: number;
  stopped: boolean;
}

interface Task {
  batch: Batch;
  target: EpisodeTarget;
}

/** Intervalle entre deux demandes (l'extension 111477 accepte 10 requêtes par 10 s). */
const SPACING_MS = 1_200;

export class EpisodeQueue {
  private readonly tasks: Task[] = [];
  /** Épisode en cours de demande. */
  private current: Task | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly handle: (titleId: number, target: EpisodeTarget) => Promise<EpisodeOutcome>,
    private readonly report: (summary: BatchSummary) => void,
    private readonly logger: Logger,
    private readonly spacingMs = SPACING_MS,
  ) {}

  private waiting(titleId: number): Task[] {
    return [...(this.current ? [this.current] : []), ...this.tasks].filter(
      (task) => task.batch.titleId === titleId,
    );
  }

  /** Épisodes en attente (ou en cours de demande) pour un titre. */
  pendingFor(titleId: number): number {
    return this.waiting(titleId).length;
  }

  add(titleId: number, label: string, targets: EpisodeTarget[]): number {
    if (targets.length === 0) return 0;
    const queued = new Set(
      this.waiting(titleId).map((task) => `${task.target.season}x${task.target.episode}`),
    );
    const fresh = targets.filter((target) => !queued.has(`${target.season}x${target.episode}`));
    if (fresh.length === 0) return 0;
    const batch: Batch = {
      titleId,
      label,
      remaining: fresh.length,
      added: 0,
      skipped: [],
      abandoned: 0,
      stopped: false,
    };
    for (const target of fresh) this.tasks.push({ batch, target });
    void this.run();
    return fresh.length;
  }

  stop(): void {
    this.stopping = true;
    this.tasks.length = 0;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let first = true;
      while (!this.stopping) {
        const task = this.tasks.shift();
        if (!task) break;
        const { batch, target } = task;
        if (batch.stopped) {
          batch.abandoned += 1;
          this.settle(batch);
          continue;
        }
        this.current = task;
        if (!first) await sleep(this.spacingMs);
        first = false;
        let outcome: EpisodeOutcome;
        try {
          outcome = await this.handle(batch.titleId, target);
        } catch (error) {
          outcome = { status: 'skipped', reason: errorMessage(error), limited: false };
        } finally {
          this.current = null;
        }
        if (outcome.status === 'added') {
          batch.added += 1;
        } else {
          batch.skipped.push({
            code: formatEpisodeCode(target.season, target.episode) ?? `${target.episode}`,
            reason: outcome.reason,
          });
        }
        // Limite atteinte : les autres épisodes de ce lot attendront une nouvelle demande.
        if (outcome.limited) batch.stopped = true;
        this.settle(batch);
      }
    } finally {
      this.running = false;
    }
  }

  private settle(batch: Batch): void {
    batch.remaining -= 1;
    if (batch.remaining > 0) return;
    const summary: BatchSummary = {
      label: batch.label,
      added: batch.added,
      skipped: batch.skipped,
      abandoned: batch.abandoned,
    };
    this.logger.info(
      {
        label: batch.label,
        added: batch.added,
        skipped: batch.skipped.length,
        abandoned: batch.abandoned,
      },
      'Épisodes demandés à l’extension Stremio',
    );
    this.report(summary);
  }
}
