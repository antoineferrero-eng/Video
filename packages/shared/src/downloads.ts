export type DownloadStatus =
  'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';

export type DownloadKind = 'movie' | 'episode' | 'file';

export interface DownloadItem {
  id: number;
  kind: DownloadKind;
  status: DownloadStatus;
  titleId: number | null;
  title: string;
  subtitle: string | null;
  season: number | null;
  episode: number | null;
  fileName: string;
  remotePath: string;
  targetPath: string;
  totalBytes: number | null;
  downloadedBytes: number;
  /** Débit instantané (octets/seconde). */
  speed: number;
  /** Temps restant estimé (secondes). */
  eta: number | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  posterUrl: string | null;
  libraryItemId: number | null;
}

export interface DownloadStats {
  active: number;
  queued: number;
  paused: number;
  failed: number;
  completed: number;
  speed: number;
}

export interface DownloadList {
  items: DownloadItem[];
  stats: DownloadStats;
}

export interface EnqueueFilesRequest {
  files: Array<{ path: string; titleId?: number | null }>;
}

export interface EnqueueSeriesRequest {
  titleId: number;
  /** Numéro de saison ; toutes les saisons si absent. */
  season?: number | null;
}

export interface EnqueueResult {
  created: DownloadItem[];
  skipped: Array<{ path: string; reason: string }>;
  /**
   * Épisodes dont le fichier est demandé aux extensions Stremio en arrière-plan : ils
   * rejoignent la file un par un (bilan annoncé par l'événement `downloads.notice`).
   */
  pending?: number;
}

/** Lien 1fichier à télécharger (obtenu sur une source personnalisée). */
export interface OneFichierLinkRequest {
  /** Lien 1fichier, ou texte copié qui en contient un. */
  url: string;
  /** Mot de passe du fichier, s'il en a un. */
  password?: string;
  /** Titre du catalogue auquel rattacher le fichier. */
  titleId?: number | null;
  /** Saison cherchée (série) : pour les épisodes dont le nom ne la donne pas. */
  season?: number | null;
  /** Archive lisible directement : éléments à télécharger (toutes ses vidéos par défaut). */
  entries?: string[];
}

/** Vidéo d'une archive zip. */
export interface ArchiveEntryInfo {
  /** Chemin dans Lumière (`<archive>/<fichier>`). */
  path: string;
  name: string;
  size: number;
  season: number | null;
  episode: number | null;
}

/** Contenu d'une archive zip (une saison complète, par exemple). */
export interface ArchiveContent {
  /**
   * Vidéos stockées sans compression : chacune se télécharge (ou se regarde) seule,
   * directement dans l'archive. Sinon l'archive est téléchargée en entier puis décompressée.
   */
  streamable: boolean;
  entries: ArchiveEntryInfo[];
}

/** Fichier désigné par un lien 1fichier (vérifié auprès de l'API). */
export interface OneFichierFileInfo {
  /** Lien normalisé (https://1fichier.com/?…). */
  url: string;
  fileName: string;
  size: number | null;
  /** Chemin du fichier dans Lumière (téléchargements, bibliothèque, lecture). */
  path: string;
  /** Contenu d'une archive zip, null pour un autre fichier. */
  archive: ArchiveContent | null;
  /** Archive zip dont le contenu n'a pas pu être lu (elle reste téléchargeable). */
  archiveError: string | null;
}
