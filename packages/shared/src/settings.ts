export type PreferredQuality = '2160p' | '1080p' | '720p' | 'smallest';
/**
 * Connexion à la source : automatique (requête standard, puis imitation de Chrome si la source
 * filtre les robots), standard uniquement, ou imitation de navigateur systématique.
 */
export type SourceConnection = 'auto' | 'standard' | 'browser';
export type TranscodePreset = 'quality' | 'balanced' | 'fast';
/**
 * Origine du catalogue : liste complète de la source, catalogue TMDB (le dossier de chaque
 * titre est cherché sur la source à l'ouverture de sa fiche), ou automatique (la liste
 * complète si elle est accessible, sinon TMDB).
 */
export type CatalogSource = 'auto' | 'listing' | 'tmdb';

export interface AppSettings {
  /** URL racine de l'index HTTP (ex. https://a.111477.xyz). */
  sourceBaseUrl: string;
  /** Dossier distant contenant les films. */
  moviesPath: string;
  /** Dossier distant contenant les séries. */
  seriesPath: string;
  userAgent: string;
  sourceConnection: SourceConnection;
  /**
   * Manifeste d'une extension Stremio qui fournit les liens des fichiers (vide : désactivé).
   * Quand elle est active, le catalogue vient de TMDB et les fichiers de l'extension.
   */
  stremioAddonUrl: string;
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
  catalogSource: CatalogSource;
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
