import path from 'node:path';
import type { AppSettings, SettingsResponse, SettingsUpdate } from '@lumiere/shared';
import type { AppConfig } from '../../config/env';
import { BadRequestError, errorMessage } from '../../core/errors';
import { assertWritableDir } from '../../core/fs';
import { transaction, type Db } from '../../infra/database/database';
import { normalizeDirPath } from '../source/remote-path';
import { normalizeAddonUrl } from '../source/stremio/stremio-addon';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const TMDB_KEY = 'tmdbApiKey';

export function defaultSettings(config: AppConfig): AppSettings {
  return {
    sourceBaseUrl: config.defaults.sourceBaseUrl,
    moviesPath: normalizeDirPath(config.defaults.moviesPath),
    seriesPath: normalizeDirPath(config.defaults.seriesPath),
    userAgent: DEFAULT_USER_AGENT,
    sourceConnection: 'auto',
    stremioAddonUrl: defaultAddonUrl(config.defaults.stremioAddonUrl),
    downloadDir: config.defaults.downloadDir,
    maxConcurrentDownloads: 2,
    maxDownloadSpeedKbps: 0,
    preferredQuality: '1080p',
    metadataLanguage: 'fr-FR',
    preferredAudioLanguage: 'fr',
    preferredSubtitleLanguage: '',
    catalogRefreshHours: 12,
    catalogSource: 'auto',
    transcodePreset: 'balanced',
    maxTranscodeHeight: 1080,
  };
}

function defaultAddonUrl(value: string): string {
  try {
    return normalizeAddonUrl(value);
  } catch {
    return '';
  }
}

export type SettingsListener = (next: AppSettings, previous: AppSettings) => void;

/** Paramètres modifiables depuis l'interface, persistés en base (valeurs par défaut issues de l'environnement). */
export class SettingsService {
  private current: AppSettings;
  private storedTmdbKey: string | null;
  private readonly listeners = new Set<SettingsListener>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {
    const defaults = defaultSettings(config);
    const stored = this.readStored();
    const merged = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      if (key in stored) merged[key] = stored[key];
    }
    this.current = merged as unknown as AppSettings;
    this.storedTmdbKey = typeof stored[TMDB_KEY] === 'string' ? (stored[TMDB_KEY] as string) : null;
  }

  get(): AppSettings {
    return this.current;
  }

  getTmdbApiKey(): string | null {
    const key = this.storedTmdbKey ?? this.config.tmdb.envApiKey;
    return key && key.trim() ? key.trim() : null;
  }

  toResponse(): SettingsResponse {
    return {
      settings: this.current,
      tmdbApiKeyConfigured: this.getTmdbApiKey() !== null,
      tmdbApiKeyFromEnv: this.storedTmdbKey === null && this.config.tmdb.envApiKey !== null,
    };
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: SettingsUpdate): Promise<AppSettings> {
    const previous = this.current;
    const next: AppSettings = { ...previous };

    if (patch.sourceBaseUrl !== undefined) {
      next.sourceBaseUrl = patch.sourceBaseUrl.trim().replace(/\/+$/, '');
    }
    if (patch.moviesPath !== undefined) next.moviesPath = normalizeDirPath(patch.moviesPath);
    if (patch.seriesPath !== undefined) next.seriesPath = normalizeDirPath(patch.seriesPath);
    if (patch.stremioAddonUrl !== undefined)
      next.stremioAddonUrl = normalizeAddonUrl(patch.stremioAddonUrl);
    if (patch.userAgent !== undefined)
      next.userAgent = patch.userAgent.trim() || DEFAULT_USER_AGENT;
    if (patch.downloadDir !== undefined) {
      const dir = path.resolve(patch.downloadDir.trim());
      try {
        await assertWritableDir(dir);
      } catch (error) {
        throw new BadRequestError(
          `Dossier de téléchargement inaccessible : ${errorMessage(error)}`,
        );
      }
      next.downloadDir = dir;
    }
    for (const key of [
      'sourceConnection',
      'maxConcurrentDownloads',
      'maxDownloadSpeedKbps',
      'preferredQuality',
      'metadataLanguage',
      'preferredAudioLanguage',
      'preferredSubtitleLanguage',
      'catalogRefreshHours',
      'catalogSource',
      'transcodePreset',
      'maxTranscodeHeight',
    ] as const) {
      if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
    }

    const write = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    const tmdbChanged = patch.tmdbApiKey !== undefined;
    const writeSecret = (name: string, raw: string | undefined) => {
      const value = raw?.trim() ?? '';
      if (value) write.run(name, JSON.stringify(value), now);
      else this.db.prepare('DELETE FROM settings WHERE key = ?').run(name);
    };
    transaction(this.db, () => {
      for (const key of Object.keys(next) as Array<keyof AppSettings>) {
        if (next[key] !== previous[key]) write.run(key, JSON.stringify(next[key]), now);
      }
      if (tmdbChanged) writeSecret(TMDB_KEY, patch.tmdbApiKey);
    });

    if (tmdbChanged) this.storedTmdbKey = patch.tmdbApiKey?.trim() || null;
    this.current = next;
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  private readStored(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        // Valeur corrompue : ignorée, la valeur par défaut s'applique.
      }
    }
    return result;
  }
}
