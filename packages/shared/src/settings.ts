export type PreferredQuality = '2160p' | '1080p' | '720p' | 'smallest';
export type TranscodePreset = 'quality' | 'balanced' | 'fast';

export interface AppSettings {
  /** URL racine de l'index HTTP (ex. https://a.111477.xyz). */
  sourceBaseUrl: string;
  /** Dossier distant contenant les films. */
  moviesPath: string;
  /** Dossier distant contenant les séries. */
  seriesPath: string;
  userAgent: string;
  /** Dossier local de téléchargement (bibliothèque). */
  downloadDir: string;
  maxConcurrentDownloads: number;
  /** Limite de débit globale en Kio/s (0 = illimité). */
  maxDownloadSpeedKbps: number;
  preferredQuality: PreferredQuality;
  metadataLanguage: string;
  /** Code langue ISO 639-1 préféré pour l'audio (ex. `fr`), vide = piste par défaut. */
  preferredAudioLanguage: string;
  /** Code langue ISO 639-1 préféré pour les sous-titres, vide = désactivés. */
  preferredSubtitleLanguage: string;
  catalogRefreshHours: number;
  transcodePreset: TranscodePreset;
  maxTranscodeHeight: number;
}

/** Paramètres renvoyés au client : la clé TMDB n'est jamais renvoyée en clair. */
export interface SettingsResponse {
  settings: AppSettings;
  tmdbApiKeyConfigured: boolean;
  tmdbApiKeyFromEnv: boolean;
}

export type SettingsUpdate = Partial<AppSettings> & {
  /** Nouvelle clé TMDB (chaîne vide pour la supprimer). */
  tmdbApiKey?: string;
};
