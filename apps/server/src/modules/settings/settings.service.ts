import path from 'node:path';
import type { AppSettings, SettingsResponse, SettingsUpdate } from '@lumiere/shared';
import type { AppConfig } from '../../config/env';
import { BadRequestError, errorMessage } from '../../core/errors';
import { assertWritableDir } from '../../core/fs';
import { transaction, type Db } from '../../infra/database/database';
import { normalizeAddonUrl, normalizeAddonUrls } from '../source/stremio/stremio-addon';

const TMDB_KEY = 'tmdbApiKey';
const OPENSUBTITLES_KEY = 'openSubtitlesApiKey';
const OPENSUBTITLES_PASSWORD = 'openSubtitlesPassword';

export function defaultSettings(config: AppConfig): AppSettings {
  return {
    stremioAddonUrls: validAddonUrls(config.defaults.stremioAddonUrls),
    downloadDir: config.defaults.downloadDir,
    maxConcurrentDownloads: 2,
    maxDownloadSpeedKbps: 0,
    preferredQuality: '1080p',
    metadataLanguage: 'fr-FR',
    preferredAudioLanguage: 'fr',
    preferredSubtitleLanguage: '',
    subtitleAddonUrls: validAddonUrls(config.defaults.subtitleAddonUrls),
    openSubtitlesUsername: '',
    catalogRefreshHours: 12,
    catalogSize: 5000,
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

/** Adresses d'extensions valides et sans doublon (les adresses invalides sont ignorées). */
function validAddonUrls(values: string[]): string[] {
  return [...new Set(values.map(defaultAddonUrl).filter(Boolean))];
}

export type SettingsListener = (next: AppSettings, previous: AppSettings) => void;

/** Paramètres modifiables depuis l'interface, persistés en base (valeurs par défaut issues de l'environnement). */
export class SettingsService {
  private current: AppSettings;
  private storedTmdbKey: string | null;
  private storedOpenSubtitlesKey: string | null;
  private storedOpenSubtitlesPassword: string | null;
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
    const secret = (key: string) =>
      typeof stored[key] === 'string' ? (stored[key] as string) : null;
    this.storedTmdbKey = secret(TMDB_KEY);
    this.storedOpenSubtitlesKey = secret(OPENSUBTITLES_KEY);
    this.storedOpenSubtitlesPassword = secret(OPENSUBTITLES_PASSWORD);
  }

  get(): AppSettings {
    return this.current;
  }

  getTmdbApiKey(): string | null {
    const key = this.storedTmdbKey ?? this.config.tmdb.envApiKey;
    return key && key.trim() ? key.trim() : null;
  }

  getOpenSubtitlesApiKey(): string | null {
    const key = this.storedOpenSubtitlesKey ?? this.config.openSubtitles.envApiKey;
    return key && key.trim() ? key.trim() : null;
  }

  /** Compte OpenSubtitles.com complet (identifiant et mot de passe), sinon null. */
  getOpenSubtitlesCredentials(): { username: string; password: string } | null {
    const username = this.current.openSubtitlesUsername.trim();
    const password = this.storedOpenSubtitlesPassword ?? '';
    return username && password ? { username, password } : null;
  }

  toResponse(): SettingsResponse {
    return {
      settings: this.current,
      tmdbApiKeyConfigured: this.getTmdbApiKey() !== null,
      tmdbApiKeyFromEnv: this.storedTmdbKey === null && this.config.tmdb.envApiKey !== null,
      openSubtitlesApiKeyConfigured: this.getOpenSubtitlesApiKey() !== null,
      openSubtitlesApiKeyFromEnv:
        this.storedOpenSubtitlesKey === null && this.config.openSubtitles.envApiKey !== null,
      openSubtitlesPasswordConfigured: Boolean(this.storedOpenSubtitlesPassword),
    };
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: SettingsUpdate): Promise<AppSettings> {
    const previous = this.current;
    const next: AppSettings = { ...previous };

    if (patch.stremioAddonUrls !== undefined)
      next.stremioAddonUrls = normalizeAddonUrls(patch.stremioAddonUrls);
    if (patch.subtitleAddonUrls !== undefined)
      next.subtitleAddonUrls = normalizeAddonUrls(patch.subtitleAddonUrls);
    if (patch.openSubtitlesUsername !== undefined)
      next.openSubtitlesUsername = patch.openSubtitlesUsername.trim();
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
      'maxConcurrentDownloads',
      'maxDownloadSpeedKbps',
      'preferredQuality',
      'metadataLanguage',
      'preferredAudioLanguage',
      'preferredSubtitleLanguage',
      'catalogRefreshHours',
      'catalogSize',
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
    const openSubtitlesKeyChanged = patch.openSubtitlesApiKey !== undefined;
    const openSubtitlesPasswordChanged = patch.openSubtitlesPassword !== undefined;
    const writeSecret = (name: string, raw: string | undefined, trim = true) => {
      const value = (trim ? raw?.trim() : raw) ?? '';
      if (value) write.run(name, JSON.stringify(value), now);
      else this.db.prepare('DELETE FROM settings WHERE key = ?').run(name);
    };
    transaction(this.db, () => {
      for (const key of Object.keys(next) as Array<keyof AppSettings>) {
        if (next[key] !== previous[key]) write.run(key, JSON.stringify(next[key]), now);
      }
      if (tmdbChanged) writeSecret(TMDB_KEY, patch.tmdbApiKey);
      if (openSubtitlesKeyChanged) writeSecret(OPENSUBTITLES_KEY, patch.openSubtitlesApiKey);
      if (openSubtitlesPasswordChanged)
        writeSecret(OPENSUBTITLES_PASSWORD, patch.openSubtitlesPassword, false);
    });

    if (tmdbChanged) this.storedTmdbKey = patch.tmdbApiKey?.trim() || null;
    if (openSubtitlesKeyChanged)
      this.storedOpenSubtitlesKey = patch.openSubtitlesApiKey?.trim() || null;
    if (openSubtitlesPasswordChanged)
      this.storedOpenSubtitlesPassword = patch.openSubtitlesPassword || null;
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
