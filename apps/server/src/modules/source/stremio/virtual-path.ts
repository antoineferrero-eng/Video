/**
 * Chemins « virtuels » des fichiers fournis par une extension Stremio.
 *
 * Les liens d'une extension peuvent expirer ou changer d'une demande à l'autre : ils ne
 * peuvent pas servir d'identité. Chaque fichier reçoit donc un chemin stable, construit à
 * partir de l'identifiant du titre et du nom du fichier, que le reste de l'application
 * (téléchargements, reprise, bibliothèque, lecture) manipule comme un chemin de la source.
 * Le lien réel n'est demandé à l'extension qu'au moment de lire les octets.
 *
 *   /@stremio/movie/tt1677720/Ready.Player.One.2018.1080p.mkv
 *   /@stremio/series/tt0903747/1x3/Breaking.Bad.S01E03.720p.mkv
 */

export const VIRTUAL_ROOT = '/@stremio/';

export type AddonKind = 'movie' | 'series';

export interface VirtualRef {
  kind: AddonKind;
  /** Identifiant compris par l'extension (« tt… » ou « tmdb:… »), sans saison ni épisode. */
  id: string;
  season: number | null;
  episode: number | null;
  /** Nom du fichier, null pour le dossier d'un titre. */
  fileName: string | null;
}

export function isVirtualPath(path: string): boolean {
  return path.startsWith(VIRTUAL_ROOT);
}

/** Dossier virtuel d'un titre (préfixe de tous ses fichiers). */
export function virtualFolder(kind: AddonKind, id: string): string {
  return `${VIRTUAL_ROOT}${kind}/${id}/`;
}

export function virtualFilePath(ref: {
  kind: AddonKind;
  id: string;
  season?: number | null;
  episode?: number | null;
  fileName: string;
}): string {
  const episode =
    ref.kind === 'series' && ref.season !== null && ref.season !== undefined
      ? `${ref.season}x${ref.episode ?? 0}/`
      : '';
  return `${virtualFolder(ref.kind, ref.id)}${episode}${ref.fileName}`;
}

export function parseVirtualPath(path: string): VirtualRef | null {
  if (!isVirtualPath(path)) return null;
  const parts = path.slice(VIRTUAL_ROOT.length).split('/');
  const [kind, id] = parts;
  if ((kind !== 'movie' && kind !== 'series') || !id) return null;
  if (kind === 'movie') {
    return { kind, id, season: null, episode: null, fileName: parts[2] || null };
  }
  const code = /^(\d+)x(\d+)$/.exec(parts[2] ?? '');
  return {
    kind,
    id,
    season: code ? Number(code[1]) : null,
    episode: code ? Number(code[2]) : null,
    fileName: code ? parts[3] || null : null,
  };
}

/** Nom de fichier sûr (pas de séparateur de dossier ni de caractère de contrôle). */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, '-')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'video.mkv').slice(0, 240);
}
