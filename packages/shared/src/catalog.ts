import type { DownloadStatus } from './downloads';

/** Type de titre du catalogue. */
export type TitleKind = 'movie' | 'series';

/** Tri disponible pour le catalogue. */
export type CatalogSort = 'recent' | 'title' | 'year' | 'rating';

/** État de la récupération des métadonnées (TMDB) d'un titre. */
export type MetadataStatus = 'pending' | 'matched' | 'not_found' | 'disabled' | 'error';

/**
 * Présence d'un titre sur la source : vu dans la liste ou retrouvé (`present`), venu de TMDB
 * et pas encore cherché (`unknown`), ou cherché sans succès (`missing`).
 */
export type SourceStatus = 'present' | 'unknown' | 'missing';

/** Origine du catalogue : liste complète de la source, ou TMDB (dossier cherché à la demande). */
export type CatalogMode = 'listing' | 'tmdb';

/** Informations techniques déduites du nom de fichier d'une release. */
export interface ReleaseInfo {
  resolution: string | null;
  source: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hdr: string | null;
  languages: string[];
  service: string | null;
  edition: string | null;
  group: string | null;
}

/** Progression de visionnage d'un média. */
export interface WatchState {
  position: number;
  duration: number | null;
  completed: boolean;
  updatedAt: string;
}

/** Disponibilité locale d'un fichier distant (téléchargement, bibliothèque, visionnage). */
export interface MediaAvailability {
  download: { id: number; status: DownloadStatus; progress: number | null } | null;
  libraryItemId: number | null;
  watch: WatchState | null;
}

/** Fichier vidéo disponible sur la source distante. */
export interface RemoteFile {
  name: string;
  /** Chemin (décodé) relatif à la racine de la source, ex. `/movies/Titre (2020)/fichier.mkv`. */
  path: string;
  size: number | null;
  modifiedAt: string | null;
  release: ReleaseInfo;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  availability: MediaAvailability;
}

/** Fichier de sous-titres disponible à côté des vidéos. */
export interface RemoteSubtitle {
  name: string;
  path: string;
  language: string | null;
}

/** Résumé d'un titre (carte d'affiche). */
export interface TitleSummary {
  id: number;
  kind: TitleKind;
  title: string;
  year: number | null;
  folderName: string;
  /** URL de l'affiche, `null` lorsqu'aucune illustration n'est disponible. */
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  genres: string[];
  overview: string | null;
  addedAt: string | null;
  /** Nombre de fichiers déjà présents dans la bibliothèque locale. */
  libraryCount: number;
  sourceStatus: SourceStatus;
}

export interface EpisodeEntry {
  key: string;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  title: string;
  overview: string | null;
  stillUrl: string | null;
  airDate: string | null;
  runtime: number | null;
  files: RemoteFile[];
}

export interface SeasonEntry {
  key: string;
  number: number | null;
  name: string;
  path: string | null;
  posterUrl: string | null;
  overview: string | null;
  episodes: EpisodeEntry[];
}

/** Détail complet d'un titre, structure distante incluse. */
export interface TitleDetails extends TitleSummary {
  remotePath: string;
  originalTitle: string | null;
  tagline: string | null;
  runtime: number | null;
  releaseDate: string | null;
  tmdbId: number | null;
  metadataStatus: MetadataStatus;
  /** Versions disponibles (films) ou fichiers isolés (séries). */
  files: RemoteFile[];
  subtitles: RemoteSubtitle[];
  /** Saisons et épisodes (séries uniquement). */
  seasons: SeasonEntry[];
  /** Dossiers essayés sur la source quand le titre y est introuvable. */
  sourceTried: string[];
}

export interface CatalogQuery {
  kind?: TitleKind;
  q?: string;
  sort?: CatalogSort;
  genre?: string;
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export type CatalogSectionState = 'idle' | 'refreshing' | 'error';

export interface CatalogSectionStatus {
  kind: TitleKind;
  path: string;
  state: CatalogSectionState;
  count: number;
  lastRefreshAt: string | null;
  lastError: string | null;
  /** D'où vient le catalogue de cette section. */
  mode: CatalogMode;
  /** Explication à afficher (par ex. pourquoi le catalogue vient de TMDB). */
  note: string | null;
}

export interface HomeFeed {
  featured: TitleSummary[];
  recentMovies: TitleSummary[];
  recentSeries: TitleSummary[];
  sections: CatalogSectionStatus[];
}

export interface GenreCount {
  name: string;
  count: number;
}
