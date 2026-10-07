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
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
