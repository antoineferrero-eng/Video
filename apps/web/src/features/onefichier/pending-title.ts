/**
 * Titre dont on cherche un fichier sur une source personnalisée : retenu au clic sur
 * « Chercher sur … », il rattache le lien 1fichier collé (ou envoyé par le favori) au bon
 * film, ou à la bonne saison d'une série. Gardé dans le navigateur, le favori ouvrant
 * Lumière dans un autre onglet.
 */
const STORAGE_KEY = 'lumiere.1fichier.titre';
const MAX_AGE_MS = 3 * 60 * 60_000;

export interface PendingTitle {
  id: number;
  title: string;
  year: number | null;
  kind: 'movie' | 'series';
  /** Saison cherchée (série). */
  season: number | null;
  /** Nom de la source ouverte (null : fiche ouverte dans Lumière). */
  source: string | null;
  at: number;
}

/** Fiche ouverte dans Lumière (un lien collé sur sa page lui revient). */
let pageTitle: PendingTitle | null = null;

export function setPageTitle(title: Omit<PendingTitle, 'at' | 'source'> | null): void {
  pageTitle = title && { ...title, source: null, at: Date.now() };
}

/**
 * Titre auquel rattacher un lien reçu : celui de la recherche lancée depuis cette fiche (il
 * connaît la saison), sinon la fiche ouverte, sinon la dernière recherche (favori, qui ouvre
 * Lumière dans un nouvel onglet).
 */
export function linkTarget(fromSearch: boolean): PendingTitle | null {
  const pending = readPendingTitle();
  if (fromSearch || !pageTitle) return pending;
  return pending?.id === pageTitle.id ? pending : pageTitle;
}

export function rememberPendingTitle(title: Omit<PendingTitle, 'at'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...title, at: Date.now() }));
  } catch {
    // Stockage indisponible (navigation privée) : le lien ne sera pas rattaché d'office.
  }
}

export function readPendingTitle(): PendingTitle | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PendingTitle | null;
    if (!value || typeof value.id !== 'number' || Date.now() - value.at > MAX_AGE_MS) return null;
    return { ...value, kind: value.kind ?? 'movie', season: value.season ?? null };
  } catch {
    return null;
  }
}

/** Libellé du titre en attente : « Titre (2024) », ou « Série · saison 2 ». */
export function pendingLabel(title: PendingTitle): string {
  if (title.kind === 'series' && title.season !== null) {
    return `${title.title} · saison ${title.season}`;
  }
  return `${title.title}${title.year ? ` (${title.year})` : ''}`;
}
