import type { PreferredQuality } from '@lumiere/shared';
import { parseRelease, resolutionRank } from './release-parser';

const FRENCH_TAGS = new Set([
  'MULTi',
  'VFF',
  'VFQ',
  'VFI',
  'VF',
  'VF2',
  'VOF',
  'TRUEFRENCH',
  'FRENCH',
]);

/**
 * Choisit la meilleure version d'un épisode/film selon les préférences
 * (qualité visée, langue audio), utilisé pour les téléchargements groupés.
 */
export function pickPreferredFile<T extends { name: string; size: number | null }>(
  files: T[],
  preferredQuality: PreferredQuality,
  preferredAudioLanguage: string,
): T | null {
  if (files.length === 0) return null;
  if (preferredQuality === 'smallest') {
    return [...files].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0] ?? null;
  }
  const target = resolutionRank(preferredQuality);
  let best: { file: T; score: number } | null = null;
  for (const file of files) {
    const info = parseRelease(file.name).info;
    const rank = resolutionRank(info.resolution);
    let score =
      rank < 0
        ? 0
        : rank === target
          ? 100
          : 60 - Math.abs(rank - target) * 10 - (rank > target ? 5 : 0);
    if (preferredAudioLanguage === 'fr' && info.languages.some((tag) => FRENCH_TAGS.has(tag)))
      score += 20;
    if (preferredAudioLanguage === 'en' && info.languages.includes('VOSTFR')) score += 5;
    score += Math.min(5, (file.size ?? 0) / 1024 ** 3) * 0.2;
    if (!best || score > best.score) best = { file, score };
  }
  return best?.file ?? null;
}

/** Tri des versions : meilleure résolution d'abord, puis taille décroissante. */
export function compareByQuality<T extends { name: string; size: number | null }>(
  a: T,
  b: T,
): number {
  const rankA = resolutionRank(parseRelease(a.name).info.resolution);
  const rankB = resolutionRank(parseRelease(b.name).info.resolution);
  return rankB - rankA || (b.size ?? 0) - (a.size ?? 0) || a.name.localeCompare(b.name);
}
