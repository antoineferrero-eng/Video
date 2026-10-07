import { parseEpisode, parseSeasonFolder, seasonLabel } from '../../domain/episode-parser';
import { classifyFile, isSampleFile } from '../../domain/media-files';
import type { RemoteEntry } from '../source/source-client';

export interface GroupedEpisode {
  key: string;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  files: RemoteEntry[];
}

export interface GroupedSeason {
  key: string;
  number: number | null;
  name: string;
  path: string | null;
  episodes: GroupedEpisode[];
}

export interface FolderListing {
  dir: RemoteEntry;
  entries: RemoteEntry[];
}

const isVideo = (entry: RemoteEntry) =>
  !entry.isDirectory && classifyFile(entry.name) === 'video' && !isSampleFile(entry.name);

/**
 * Regroupe les fichiers d'une série en saisons/épisodes à partir de la structure distante :
 * dossiers de saison (« Season 1 », « S02 »…) et/ou fichiers à la racine (« Show.S01E02… »).
 */
export function groupSeries(rootEntries: RemoteEntry[], folders: FolderListing[]): GroupedSeason[] {
  const seasons = new Map<string, GroupedSeason>();
  const episodesBySeason = new Map<string, Map<string, GroupedEpisode>>();

  const seasonFor = (number: number | null, fallbackName: string | null, path: string | null) => {
    const key = number !== null ? `s${number}` : `d:${fallbackName ?? ''}`;
    let season = seasons.get(key);
    if (!season) {
      season = {
        key,
        number,
        name: number !== null ? seasonLabel(number) : (fallbackName ?? seasonLabel(null)),
        path,
        episodes: [],
      };
      seasons.set(key, season);
      episodesBySeason.set(key, new Map());
    } else if (!season.path && path) {
      season.path = path;
    }
    return season;
  };

  const addFile = (entry: RemoteEntry, folderSeason: number | null, folder: RemoteEntry | null) => {
    const ref = parseEpisode(entry.name, folderSeason);
    const seasonNumber = ref.season ?? folderSeason;
    const season =
      seasonNumber !== null
        ? seasonFor(
            seasonNumber,
            null,
            folder && folderSeason === seasonNumber ? folder.path : null,
          )
        : seasonFor(null, folder?.name ?? null, folder?.path ?? null);
    const episodes = episodesBySeason.get(season.key) as Map<string, GroupedEpisode>;
    const episodeKey = ref.episode !== null ? `e${ref.episode}` : `f:${entry.name}`;
    let episode = episodes.get(episodeKey);
    if (!episode) {
      episode = {
        key: `${season.key}-${episodeKey}`,
        season: seasonNumber,
        episode: ref.episode,
        episodeEnd: ref.episodeEnd,
        files: [],
      };
      episodes.set(episodeKey, episode);
    }
    episode.files.push(entry);
  };

  for (const { dir, entries } of folders) {
    const folderSeason = parseSeasonFolder(dir.name);
    const videos = entries.filter(isVideo);
    if (videos.length === 0 && folderSeason !== null) seasonFor(folderSeason, null, dir.path);
    for (const video of videos) addFile(video, folderSeason, dir);
  }
  for (const video of rootEntries.filter(isVideo)) addFile(video, null, null);

  const ordered = [...seasons.values()].filter((season) => {
    season.episodes = [...(episodesBySeason.get(season.key)?.values() ?? [])].sort(compareEpisodes);
    return season.episodes.length > 0 || season.number !== null;
  });
  return ordered.sort(compareSeasons);
}

function compareSeasons(a: GroupedSeason, b: GroupedSeason): number {
  const rank = (season: GroupedSeason) =>
    season.number === null ? 1e6 : season.number === 0 ? 1e5 : season.number;
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function compareEpisodes(a: GroupedEpisode, b: GroupedEpisode): number {
  const rank = (episode: GroupedEpisode) => episode.episode ?? 1e6;
  return rank(a) - rank(b) || (a.files[0]?.name ?? '').localeCompare(b.files[0]?.name ?? '');
}
