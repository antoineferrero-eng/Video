export type PreferredQuality = '2160p' | '1080p' | '720p' | 'smallest';
/**
 * Connexion à la source : automatique (requête standard, imitation de Chrome, puis ZenRows
 * si une clé est configurée, sinon vérification dans le navigateur de l'utilisateur),
 * standard uniquement, imitation de navigateur, navigateur réel, ou ZenRows pour les pages
 * de listing (les fichiers restent téléchargés directement).
 */
export type SourceConnection = 'auto' | 'standard' | 'browser' | 'real-browser' | 'zenrows';
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
  catalogSource: CatalogSource;
  transcodePreset: TranscodePreset;
  maxTranscodeHeight: number;
}

/** Paramètres renvoyés au client : la clé TMDB n'est jamais renvoyée en clair. */
export interface SettingsResponse {
  settings: AppSettings;
  tmdbApiKeyConfigured: boolean;
  tmdbApiKeyFromEnv: boolean;
  zenrowsApiKeyConfigured: boolean;
  zenrowsApiKeyFromEnv: boolean;
}

export type SettingsUpdate = Partial<AppSettings> & {
  /** Nouvelle clé TMDB (chaîne vide pour la supprimer). */
  tmdbApiKey?: string;
  /** Nouvelle clé ZenRows (chaîne vide pour la supprimer). */
  zenrowsApiKey?: string;
};
