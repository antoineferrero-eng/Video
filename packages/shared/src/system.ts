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
}

/** Façon dont une requête a joint la source. */
export type SourceTransportName = 'standard' | 'browser';

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
  /** Transport utilisé pour joindre la source (null en cas d'échec). */
  transport: SourceTransportName | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** Résultat du test de l'extension Stremio (paramètres). */
export interface AddonTestResult {
  ok: boolean;
  manifestUrl: string;
  name: string | null;
  version: string | null;
  types: string[];
  message: string;
}
