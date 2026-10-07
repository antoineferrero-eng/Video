import type { ReleaseInfo, WatchState } from './catalog';

export type LibraryKind = 'movie' | 'episode' | 'other';

export interface LibraryItem {
  id: number;
  kind: LibraryKind;
  titleId: number | null;
  /** Titre du film ou de la série. */
  title: string;
  season: number | null;
  episode: number | null;
  year: number | null;
  fileName: string;
  filePath: string;
  size: number;
  addedAt: string;
  remotePath: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  release: ReleaseInfo;
  watch: WatchState | null;
  exists: boolean;
}

export interface LibraryScanResult {
  added: number;
  removed: number;
  total: number;
}
