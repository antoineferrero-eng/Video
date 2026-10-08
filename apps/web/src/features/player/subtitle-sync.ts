import type { Cue } from '../../lib/vtt';

/** Recalage : instant d'affichage = rate × instant prévu dans le fichier + offset. */
export interface SyncValue {
  offset: number;
  rate: number;
}

/** Réplique calée à la main : prévue à `cue` dans le fichier, entendue à `media`. */
export interface Anchor {
  cue: number;
  media: number;
}

export const NO_SYNC: SyncValue = { offset: 0, rate: 1 };

/** Rapports de cadences courants (23,976 / 24 / 25 i/s) : une vitesse calculée s'y arrondit. */
const FRAME_RATE_RATIOS = [25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24];
/** Écart minimal entre deux répliques calées pour en déduire une vitesse. */
const MIN_ANCHOR_SPAN_S = 120;

/** Instant du fichier de sous-titres qui correspond à l'instant `time` de la vidéo. */
export function subtitleTime(time: number, sync: SyncValue): number {
  return (time - sync.offset) / sync.rate;
}

export function isIdentity(sync: SyncValue): boolean {
  return sync.rate === 1 && Math.abs(sync.offset) < 0.005;
}

/**
 * Réplique à caler sur l'instant présent : la prochaine à s'afficher (sous-titres en retard
 * sur la voix), ou la dernière affichée (en avance).
 */
export function anchorCue(
  cues: Cue[],
  time: number,
  sync: SyncValue,
  which: 'next' | 'previous',
): Cue | null {
  const now = subtitleTime(time, sync);
  if (which === 'next') return cues.find((cue) => cue.start > now + 0.05) ?? null;
  let previous: Cue | null = null;
  for (const cue of cues) {
    if (cue.start > now) break;
    previous = cue;
  }
  return previous;
}

/**
 * Recalage déduit des répliques calées : la dernière fixe le décalage ; avec la plus
 * éloignée d'elle (au moins 2 minutes), elle fixe aussi la vitesse (sous-titres faits pour
 * une autre cadence), arrondie au rapport de cadences le plus proche.
 */
export function syncFromAnchors(anchors: Anchor[], current: SyncValue): SyncValue {
  const last = anchors[anchors.length - 1];
  if (!last) return current;
  let first: Anchor | null = null;
  for (const anchor of anchors) {
    if (!first || Math.abs(anchor.media - last.media) > Math.abs(first.media - last.media))
      first = anchor;
  }
  let rate = current.rate;
  if (first && Math.abs(last.media - first.media) >= MIN_ANCHOR_SPAN_S) {
    const measured = (last.media - first.media) / (last.cue - first.cue);
    if (measured > 0.9 && measured < 1.1) {
      const known = FRAME_RATE_RATIOS.find((ratio) => Math.abs(ratio - measured) < 0.003);
      rate = known ?? (Math.abs(measured - 1) < 0.0015 ? 1 : measured);
    }
  }
  return { rate, offset: Math.round((last.media - rate * last.cue) * 1000) / 1000 };
}

export function formatOffset(seconds: number): string {
  const value = `${Math.abs(seconds).toFixed(2).replace('.', ',')} s`;
  return Math.abs(seconds) < 0.005 ? '0 s' : `${seconds > 0 ? '+' : '−'}${value}`;
}

/** Résumé d'un recalage (« +1,25 s », « −0,40 s · vitesse ×1,043 »). */
export function describeSync(sync: SyncValue): string {
  const offset = formatOffset(sync.offset);
  return sync.rate === 1
    ? offset
    : `${offset} · vitesse ×${sync.rate.toFixed(3).replace('.', ',')}`;
}
