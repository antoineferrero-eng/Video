import type { TitleSummary } from '@lumiere/shared';
import type { TitleRow } from './titles.repository';

export function imageUrl(imagePath: string | null | undefined, size: string): string | null {
  return imagePath ? `/api/images/${size}${imagePath}` : null;
}

/**
 * URL d'affiche : image TMDB connue, sinon point d'entrée « paresseux » qui déclenchera
 * la recherche TMDB au premier affichage, sinon `null` (l'interface génère un visuel).
 */
export function posterUrlFor(row: TitleRow, tmdbEnabled: boolean): string | null {
  if (row.poster_path) return imageUrl(row.poster_path, 'w342');
  if (tmdbEnabled && row.metadata_status === 'pending')
    return `/api/titles/${row.id}/artwork/poster`;
  return null;
}

export function backdropUrlFor(row: TitleRow, tmdbEnabled: boolean): string | null {
  if (row.backdrop_path) return imageUrl(row.backdrop_path, 'w1280');
  if (tmdbEnabled && row.metadata_status === 'pending')
    return `/api/titles/${row.id}/artwork/backdrop`;
  return null;
}

export function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function displayTitle(row: TitleRow): string {
  return row.tmdb_title ?? row.parsed_title;
}

export function toTitleSummary(
  row: TitleRow,
  tmdbEnabled: boolean,
  libraryCount = 0,
): TitleSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: displayTitle(row),
    year: row.year ?? (row.release_date ? Number(row.release_date.slice(0, 4)) || null : null),
    folderName: row.folder_name,
    posterUrl: posterUrlFor(row, tmdbEnabled),
    backdropUrl: backdropUrlFor(row, tmdbEnabled),
    rating: row.rating,
    genres: parseGenres(row.genres),
    overview: row.overview,
    addedAt: row.origin === 'tmdb' ? null : (row.remote_modified_at ?? row.first_seen_at),
    libraryCount,
    sourceStatus: row.source_status,
  };
}
