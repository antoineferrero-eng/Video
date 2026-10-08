import type { CatalogSectionStatus } from './catalog';

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
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** Résultat du test d'une extension Stremio (paramètres). */
export interface AddonTestResult {
  ok: boolean;
  manifestUrl: string;
  name: string | null;
  version: string | null;
  types: string[];
  message: string;
}
