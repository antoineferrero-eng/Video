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

export interface EnqueueFolderRequest {
  path: string;
}

export interface EnqueueResult {
  created: DownloadItem[];
  skipped: Array<{ path: string; reason: string }>;
  /**
   * Épisodes dont le fichier est demandé à l'extension Stremio en arrière-plan : ils
   * rejoignent la file un par un (bilan annoncé par l'événement `downloads.notice`).
   */
  pending?: number;
}
