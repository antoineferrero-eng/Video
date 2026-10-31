import { useSettings } from '../../api/queries';

export interface SetupStatus {
  /** Clé TMDB renseignée (le catalogue en dépend). */
  tmdb: boolean;
  /** Au moins une source de fichiers : extension Stremio ou site (lien 1fichier). */
  addons: boolean;
  complete: boolean;
}

/** Ce qu'il reste à configurer pour utiliser Lumière (null tant que les paramètres chargent). */
export function useSetupStatus(): SetupStatus | null {
  const settings = useSettings();
  if (!settings.data) return null;
  const tmdb = settings.data.tmdbApiKeyConfigured;
  const { stremioAddonUrls, customSources } = settings.data.settings;
  const addons = stremioAddonUrls.length > 0 || customSources.length > 0;
  return { tmdb, addons, complete: tmdb && addons };
}

/** Lien des paramètres sur le premier réglage manquant (clé TMDB, puis sources). */
export function setupUrl(status: SetupStatus): string {
  return status.tmdb ? '/parametres?onglet=sources#extensions' : '/parametres?onglet=services#tmdb';
}
