import type { CatalogSectionStatus } from './catalog';
import type { ExplorerEntry } from './explorer';

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  dataDir: string;
  downloadDir: string;
  disk: { free: number; total: number } | null;
  ffmpeg: { available: boolean; version: string | null; ffprobeAvailable: boolean };
  tmdbConfigured: boolean;
  catalog: CatalogSectionStatus[];
  /** Navigateur utilisé pour les vérifications Cloudflare (null si aucun n'est installé). */
  browser: { name: string; path: string } | null;
}

export interface SourceTestResult {
  ok: boolean;
  url: string;
  status: number | null;
  durationMs: number;
  format: string | null;
  directories: number;
  files: number;
  sample: ExplorerEntry[];
  error: string | null;
  /**
   * Transport utilisé : requête standard, imitation de navigateur ou navigateur réel
   * (null en cas d'échec).
   */
  transport: 'standard' | 'browser' | 'real-browser' | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
