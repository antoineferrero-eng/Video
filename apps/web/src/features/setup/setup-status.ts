import { useSettings } from '../../api/queries';

export interface SetupStatus {
  /** Clé TMDB renseignée (le catalogue en dépend). */
  tmdb: boolean;
  /** Au moins une extension Stremio (les fichiers en dépendent). */
  addons: boolean;
  complete: boolean;
}

/** Ce qu'il reste à configurer pour utiliser Lumière (null tant que les paramètres chargent). */
export function useSetupStatus(): SetupStatus | null {
  const settings = useSettings();
  if (!settings.data) return null;
  const tmdb = settings.data.tmdbApiKeyConfigured;
  const addons = settings.data.settings.stremioAddonUrls.length > 0;
  return { tmdb, addons, complete: tmdb && addons };
}

/** Lien des paramètres qui ouvre l'onglet des clés et extensions, sur le premier réglage manquant. */
export function setupUrl(status: SetupStatus): string {
  return `/parametres?onglet=services#${status.tmdb ? 'extensions' : 'tmdb'}`;
}
