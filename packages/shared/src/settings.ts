export type PreferredQuality = '2160p' | '1080p' | '720p' | 'smallest';
export type TranscodePreset = 'quality' | 'balanced' | 'fast';

export interface AppSettings {
  /**
   * Manifestes des extensions Stremio qui fournissent les liens des fichiers, par ordre de
   * préférence (le catalogue, lui, vient de TMDB). Liste vide : aucun fichier disponible.
   */
  stremioAddonUrls: string[];
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
  /**
   * Extensions Stremio de sous-titres interrogées pendant la lecture (manifestes), par
   * exemple OpenSubtitles v3. Liste vide : aucune.
   */
  subtitleAddonUrls: string[];
  /** Compte OpenSubtitles.com (facultatif : plus de téléchargements par jour). */
  openSubtitlesUsername: string;
  catalogRefreshHours: number;
  /**
   * Titres visés par section (films, séries) : les listes TMDB, complétées par « Découvrir »
   * dans l'ordre de popularité. Les titres déjà importés restent si la taille diminue.
   */
  catalogSize: number;
  transcodePreset: TranscodePreset;
  maxTranscodeHeight: number;
}

/** Paramètres renvoyés au client : les clés et mots de passe ne sont jamais renvoyés en clair. */
export interface SettingsResponse {
  settings: AppSettings;
  tmdbApiKeyConfigured: boolean;
  tmdbApiKeyFromEnv: boolean;
  openSubtitlesApiKeyConfigured: boolean;
  openSubtitlesApiKeyFromEnv: boolean;
  openSubtitlesPasswordConfigured: boolean;
}

export type SettingsUpdate = Partial<AppSettings> & {
  /** Nouvelle clé TMDB (chaîne vide pour la supprimer). */
  tmdbApiKey?: string;
  /** Nouvelle clé d'API OpenSubtitles.com (chaîne vide pour la supprimer). */
  openSubtitlesApiKey?: string;
  /** Nouveau mot de passe du compte OpenSubtitles.com (chaîne vide pour le supprimer). */
  openSubtitlesPassword?: string;
};

/** Test des services de sous-titres en ligne (paramètres). */
export interface SubtitleProvidersTestResult {
  providers: Array<{ name: string; ok: boolean; message: string }>;
}
