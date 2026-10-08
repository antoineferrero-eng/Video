/**
 * Recalage automatique de sous-titres, sur le principe de ffsubsync et alass : la référence
 * (parole détectée dans l'audio, ou une autre piste de sous-titres bien calée) et les
 * sous-titres à recaler deviennent deux signaux « on parle / on ne parle pas » ; on cherche
 * la vitesse et le décalage qui les font le mieux coïncider.
 *
 * Modèle : instant d'affichage = rate × instant prévu + offset. La vitesse couvre les
 * sous-titres faits pour une autre cadence (25 i/s contre 23,976 : 4 %, soit 5 minutes
 * d'écart à la fin d'un film de 2 h) ; le décalage, un générique ou un logo de durée
 * différente.
 */

/** Intervalle [start, end[ en secondes. */
export type Interval = [start: number, end: number];

/** Portion de référence : signal ±1 (parole / silence) échantillonné tous les `step` s. */
export interface ReferenceWindow {
  start: number;
  step: number;
  values: Float32Array;
}

export interface Alignment {
  rate: number;
  offset: number;
  /** Concordance au meilleur recalage, entre -1 et 1. */
  score: number;
  /** Écart du meilleur score à la moyenne des décalages essayés, en écarts types. */
  confidence: number;
  /** Concordance sans aucun recalage, pour comparaison. */
  baseline: number;
  /** Part des passages (extraits, ou tranches de 10 min) qui indiquent le même décalage. */
  agreement: number;
}

/** Recalage assez sûr pour être appliqué sans demander. */
export function isReliable(alignment: Alignment | null): alignment is Alignment {
  return (
    alignment !== null &&
    alignment.confidence >= 5.5 &&
    alignment.agreement >= 0.5 &&
    alignment.score >= alignment.baseline
  );
}

export interface AlignOptions {
  /** Vitesses essayées (1 toujours comprise). */
  rates?: number[];
  /** Vitesse attendue (cadence déclarée par le service de sous-titres), favorisée. */
  expectedRate?: number | null;
  /** Décalage maximal cherché, en secondes. */
  maxOffset?: number;
}

/** Rapports de cadences courants : 23,976 / 24 / 25 / 29,97 / 30 images par seconde. */
export const FRAME_RATE_RATIOS = [
  1,
  25 / 23.976,
  23.976 / 25,
  25 / 24,
  24 / 25,
  24 / 23.976,
  23.976 / 24,
];

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** Intervalles d'affichage des répliques d'un WebVTT, triés. */
export function parseCueTimes(vtt: string): Interval[] {
  const intervals: Interval[] = [];
  for (const line of vtt.split(/\r?\n/)) {
    if (!line.includes('-->')) continue;
    const [left = '', right = ''] = line.split('-->');
    const start = parseTimestamp(left);
    const end = parseTimestamp(right);
    if (start !== null && end !== null && end > start) intervals.push([start, end]);
  }
  return intervals.sort((a, b) => a[0] - b[0]);
}

function parseTimestamp(text: string): number | null {
  const match = TIMESTAMP.exec(text);
  if (!match) return null;
  const [, hours = '0', minutes = '0', seconds = '0', fraction = '0'] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, '0')) / 1000
  );
}

/**
 * Signal ±1 d'une piste de sous-titres : +1 quand une réplique est affichée, échantillonné
 * tous les `step` s de 0 à `duration`.
 */
export function cueActivity(cues: Interval[], duration: number, step: number): Float32Array {
  const values = new Float32Array(Math.max(1, Math.ceil(duration / step))).fill(-1);
  for (const [start, end] of cues) {
    const from = Math.max(0, Math.floor(start / step));
    const to = Math.min(values.length, Math.ceil(end / step));
    for (let index = from; index < to; index += 1) values[index] = 1;
  }
  return values;
}

/**
 * Indice de parole dans un extrait audio (mono, filtré sur la bande de la voix, de
 * préférence la voie centrale où se trouvent les dialogues) : énergie par tranche de 10 ms,
 * rapportée au bruit de fond local (10e centile sur ±1,5 s), puis centrée-réduite. Signal
 * continu plutôt qu'un seuil : plus robuste sous la musique et les effets.
 */
export function speechActivity(samples: Int16Array, sampleRate: number, step = 0.01): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * step));
  const count = Math.floor(samples.length / frame);
  const levels = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    let energy = 0;
    for (let offset = index * frame; offset < (index + 1) * frame; offset += 1) {
      const value = samples[offset]! / 32768;
      energy += value * value;
    }
    levels[index] = 10 * Math.log10(energy / frame + 1e-10);
  }
  // Bruit de fond : 10e centile autour de chaque instant (calculé tous les 100 ms).
  const reach = Math.round(1.5 / step);
  const stride = Math.max(1, Math.round(0.1 / step));
  const floors: number[] = [];
  for (let index = 0; index < count; index += stride) {
    const around = Array.from(
      levels.subarray(Math.max(0, index - reach), Math.min(count, index + reach)),
    ).sort((a, b) => a - b);
    floors.push(around[Math.floor(around.length * 0.1)] ?? 0);
  }
  const relative = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    relative[index] = levels[index]! - floors[Math.floor(index / stride)]!;
  }
  let mean = 0;
  for (const value of relative) mean += value;
  mean /= count || 1;
  let variance = 0;
  for (const value of relative) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / (count || 1)) || 1;
  return relative.map((value) => Math.max(-3, Math.min(3, (value - mean) / deviation)));
}

/** Ramène une portion de référence à un pas plus grossier (moyenne). */
function resample(window: ReferenceWindow, step: number): ReferenceWindow {
  const factor = Math.max(1, Math.round(step / window.step));
  if (factor === 1) return window;
  const values = new Float32Array(Math.floor(window.values.length / factor));
  for (let index = 0; index < values.length; index += 1) {
    let sum = 0;
    for (let inner = 0; inner < factor; inner += 1) sum += window.values[index * factor + inner]!;
    values[index] = sum / factor;
  }
  return { start: window.start, step: window.step * factor, values };
}

/** Découpe les portions de référence en morceaux d'au plus `length` secondes. */
function chunks(windows: ReferenceWindow[], length: number): ReferenceWindow[] {
  return windows.flatMap((window) => {
    const size = Math.max(1, Math.round(length / window.step));
    const parts: ReferenceWindow[] = [];
    for (let from = 0; from < window.values.length; from += size) {
      parts.push({
        start: window.start + from * window.step,
        step: window.step,
        values: window.values.subarray(from, from + size),
      });
    }
    return parts;
  });
}

/** Concordance moyenne entre la référence et les sous-titres recalés (rate, offset). */
function score(
  windows: ReferenceWindow[],
  activity: Float32Array,
  activityStep: number,
  rate: number,
  offset: number,
): number {
  let total = 0;
  let count = 0;
  for (const window of windows) {
    for (let index = 0; index < window.values.length; index += 1) {
      const time = window.start + index * window.step;
      const position = Math.floor((time - offset) / rate / activityStep);
      const subtitle = position >= 0 && position < activity.length ? activity[position]! : -1;
      total += window.values[index]! * subtitle;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * Meilleur recalage des sous-titres `cues` sur la référence : recherche grossière (pas de
 * 100 ms, 500 ms si la référence couvre plus de 10 minutes) pour chaque vitesse, puis
 * affinage au centième de seconde autour du meilleur décalage.
 */
export function align(
  windows: ReferenceWindow[],
  cues: Interval[],
  options: AlignOptions = {},
): Alignment | null {
  if (windows.length === 0 || cues.length === 0) return null;
  const maxOffset = options.maxOffset ?? 120;
  const rates = [...new Set([...(options.rates ?? FRAME_RATE_RATIOS), 1])];
  const covered = windows.reduce((total, window) => total + window.values.length * window.step, 0);
  const coarseStep = covered > 600 ? 0.5 : 0.1;
  const end = Math.max(
    ...windows.map((window) => window.start + window.values.length * window.step),
  );
  const duration = (end + maxOffset) * 1.1 + cues[cues.length - 1]![1];

  const passes = [coarseStep, ...(coarseStep > 0.1 ? [0.1] : []), 0.01];
  const views = new Map(
    passes.map((step) => [step, windows.map((window) => resample(window, step))]),
  );
  const activities = new Map(passes.map((step) => [step, cueActivity(cues, duration, step)]));

  // Recherche grossière : toutes les vitesses, tous les décalages.
  const coarseWindows = views.get(coarseStep)!;
  const coarseActivity = activities.get(coarseStep)!;
  const search = (parts: ReferenceWindow[], rate: number) => {
    const scores: number[] = [];
    let top = { offset: 0, score: -Infinity };
    for (let offset = -maxOffset; offset <= maxOffset + 1e-9; offset += coarseStep) {
      const value = score(parts, coarseActivity, coarseStep, rate, offset);
      scores.push(value);
      if (value > top.score) top = { offset, score: value };
    }
    return { top, scores };
  };
  let best: { rate: number; offset: number; score: number; scores: number[] } | null = null;
  for (const rate of rates) {
    const { top, scores } = search(coarseWindows, rate);
    // Vitesse différente de 1 (ou de celle attendue) retenue seulement si nettement meilleure.
    const favored =
      rate === 1 || (options.expectedRate != null && Math.abs(rate - options.expectedRate) < 1e-4);
    const adjusted = favored ? top.score : top.score - 0.02;
    if (!best || adjusted > best.score)
      best = { rate, offset: top.offset, score: adjusted, scores };
  }
  if (!best) return null;

  // Affinage autour du meilleur décalage, à des pas de plus en plus fins.
  let { offset } = best;
  for (let pass = 1; pass < passes.length; pass += 1) {
    const step = passes[pass]!;
    const span = passes[pass - 1]!;
    const view = views.get(step)!;
    const activity = activities.get(step)!;
    let top = { offset, score: -Infinity };
    for (let candidate = offset - span; candidate <= offset + span + 1e-9; candidate += step) {
      const value = score(view, activity, step, best.rate, candidate);
      if (value > top.score) top = { offset: candidate, score: value };
    }
    offset = top.offset;
  }

  const fine = views.get(0.01)!;
  const fineActivity = activities.get(0.01)!;
  const finalScore = score(fine, fineActivity, 0.01, best.rate, offset);
  const mean = best.scores.reduce((sum, value) => sum + value, 0) / best.scores.length;
  const deviation = Math.sqrt(
    best.scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / best.scores.length,
  );
  const coarseBest = Math.max(...best.scores);
  // Chaque passage, seul, doit indiquer à peu près le même décalage.
  const parts = chunks(coarseWindows, 600);
  const tolerance = Math.max(1, 2 * coarseStep);
  const agreeing = parts.filter(
    (part) => Math.abs(search([part], best.rate).top.offset - best.offset) <= tolerance,
  ).length;
  return {
    rate: best.rate,
    offset: Math.round(offset * 1000) / 1000,
    score: finalScore,
    confidence: deviation > 0 ? (coarseBest - mean) / deviation : 0,
    baseline: score(fine, fineActivity, 0.01, 1, 0),
    agreement: parts.length > 0 ? agreeing / parts.length : 0,
  };
}
