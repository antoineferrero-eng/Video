import type { CatalogSectionStatus } from './catalog';
import type { DownloadItem, DownloadStats } from './downloads';

/** Événements temps réel diffusés par le serveur (Server-Sent Events sur `/api/events`). */
export type ServerEvent =
  | { type: 'download.updated'; download: DownloadItem }
  | { type: 'download.removed'; id: number }
  | { type: 'downloads.stats'; stats: DownloadStats }
  | { type: 'library.changed' }
  | { type: 'catalog.updated'; status: CatalogSectionStatus }
  | { type: 'metadata.updated'; titleId: number }
  /** Bilan d'un ajout fait en arrière-plan (épisodes demandés à l'extension Stremio). */
  | {
      type: 'downloads.notice';
      level: 'success' | 'info' | 'warning';
      message: string;
      description: string | null;
    };

export type ServerEventType = ServerEvent['type'];
