import type { DownloadStatus } from './downloads';

/** Type de titre du catalogue. */
export type TitleKind = 'movie' | 'series';

/**
 * Tri disponible pour le catalogue. `popular` : popularité TMDB (l'ordre de la page
 * « Populaires » du site de TMDB) ; `recent` : sorties les plus récentes.
 */
export type CatalogSort = 'popular' | 'recent' | 'title' | 'year' | 'rating';

/** État de la récupération des métadonnées (TMDB) d'un titre. */
export type MetadataStatus = 'pending' | 'matched' | 'not_found' | 'disabled' | 'error';

/**
 * Présence d'un titre chez les extensions Stremio : au moins un fichier proposé (`present`),
 * pas encore demandé (`unknown`), ou demandé sans résultat (`missing`).
 */
export type SourceStatus = 'present' | 'unknown' | 'missing';

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

/** Fichier vidéo proposé par une extension Stremio. */
export interface RemoteFile {
  name: string;
  /**
   * Chemin virtuel stable du fichier, ex. `/@stremio/movie/tt1677720/fichier.mkv` (le lien
   * réel est demandé aux extensions au moment de lire les octets).
   */
  path: string;
  size: number | null;
  modifiedAt: string | null;
  release: ReleaseInfo;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  availability: MediaAvailability;
  /** Description donnée par l'extension (son nom s'il y en a plusieurs, serveur, qualité…). */
  label: string | null;
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
  posterUrl: string | null;
  overview: string | null;
  episodes: EpisodeEntry[];
}

/** Détail complet d'un titre. */
export interface TitleDetails extends TitleSummary {
  remotePath: string;
  originalTitle: string | null;
  tagline: string | null;
  runtime: number | null;
  releaseDate: string | null;
  tmdbId: number | null;
  metadataStatus: MetadataStatus;
  /** Versions proposées par les extensions (films). */
  files: RemoteFile[];
  /**
   * Saisons et épisodes (séries) : les liens d'un épisode sont demandés aux extensions à la
   * lecture ou au téléchargement (pour ménager leur limite de liens) ; ses `files` ne
   * contiennent que les copies déjà connues (téléchargées, regardées).
   */
  seasons: SeasonEntry[];
  /** Message des extensions (limite de liens atteinte…), null sinon. */
  sourceNotice: string | null;
}

/** Fichiers proposés pour un épisode par les extensions Stremio. */
export interface EpisodeFiles {
  files: RemoteFile[];
  notice: string | null;
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

/** Section du catalogue (films ou séries), importée des listes de TMDB. */
export interface CatalogSectionStatus {
  kind: TitleKind;
  state: CatalogSectionState;
  count: number;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export interface HomeFeed {
  featured: TitleSummary[];
  /** Les plus populaires d'après TMDB (vides sans données TMDB). */
  popularMovies: TitleSummary[];
  popularSeries: TitleSummary[];
  sections: CatalogSectionStatus[];
}

export interface GenreCount {
  name: string;
  count: number;
}
