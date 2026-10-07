import { stripExtension } from './media-files';

export interface EpisodeRef {
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
}

const NONE: EpisodeRef = { season: null, episode: null, episodeEnd: null };

/**
 * Extrait saison/épisode d'un nom de fichier.
 * Formats reconnus : S01E02, S01E02E03, S01E02-E03, 1x02, Saison 1 Épisode 2, E02/Ep02 (avec saison connue).
 */
export function parseEpisode(fileName: string, fallbackSeason: number | null = null): EpisodeRef {
  const name = stripExtension(fileName);

  const standard =
    /(?<![a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})(?:(?:[ ._-]?e|-)(\d{1,4}))?(?![0-9])/i.exec(name);
  if (standard) {
    const episode = Number(standard[2]);
    const end = standard[3] ? Number(standard[3]) : null;
    return {
      season: Number(standard[1]),
      episode,
      episodeEnd: end !== null && end > episode ? end : null,
    };
  }

  const cross = /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(name);
  if (cross) return { season: Number(cross[1]), episode: Number(cross[2]), episodeEnd: null };

  const verbose =
    /(?:saison|season)[ ._-]*(\d{1,3})[ ._-]*(?:[ée]pisode|episode|ep)[ ._-]*(\d{1,4})/i.exec(name);
  if (verbose) return { season: Number(verbose[1]), episode: Number(verbose[2]), episodeEnd: null };

  const episodeOnly = /(?<![a-z0-9])(?:e|ep|[ée]pisode|episode)[ ._-]*(\d{1,4})(?![0-9])/i.exec(
    name,
  );
  if (episodeOnly) {
    return { season: fallbackSeason, episode: Number(episodeOnly[1]), episodeEnd: null };
  }

  const seasonOnly = /(?<![a-z0-9])s(\d{1,3})(?![0-9a-z])/i.exec(name);
  if (seasonOnly) return { season: Number(seasonOnly[1]), episode: null, episodeEnd: null };

  // Numérotation « absolue » façon anime : « Titre - 03 ».
  const absolute = /(?:^|[ ._])-[ ._]?(\d{1,4})(?=[ ._\-[(]|v\d|$)/.exec(name);
  if (absolute && fallbackSeason !== null) {
    return { season: fallbackSeason, episode: Number(absolute[1]), episodeEnd: null };
  }

  return fallbackSeason === null ? NONE : { ...NONE, season: fallbackSeason };
}

/** Numéro de saison d'un nom de dossier (« Season 1 », « Saison 02 », « S03 », « Specials » → 0). */
export function parseSeasonFolder(folderName: string): number | null {
  const name = folderName.trim().replace(/\/+$/, '');
  if (/^(specials?|sp[ée]ciaux|extras?|bonus|hors[ ._-]?s[ée]rie)$/i.test(name)) return 0;

  const prefixed =
    /^(?:season|saison|series|staffel|temporada|stagione|s)[ ._-]*(\d{1,3})(?![0-9])/i.exec(name);
  if (prefixed) return Number(prefixed[1]);

  const embedded = /(?:^|[ ._-])(?:season|saison)[ ._-]*(\d{1,3})(?![0-9])/i.exec(name);
  if (embedded) return Number(embedded[1]);

  const releaseStyle = /(?<![a-z0-9])s(\d{1,2})(?![0-9]|e\d)/i.exec(name);
  if (releaseStyle) return Number(releaseStyle[1]);

  if (/^\d{1,2}$/.test(name)) return Number(name);
  return null;
}

export function seasonLabel(season: number | null, fallback = 'Autres fichiers'): string {
  if (season === null) return fallback;
  if (season === 0) return 'Épisodes spéciaux';
  return `Saison ${season}`;
}
