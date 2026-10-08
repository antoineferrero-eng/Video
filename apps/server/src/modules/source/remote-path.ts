import { BadRequestError } from '../../core/errors';

/**
 * Les chemins distants sont manipulés sous forme décodée : chemins virtuels des fichiers des
 * extensions (`/@stremio/movie/tt1677720/fichier.mkv`, voir stremio/virtual-path.ts). Les
 * dossiers se terminent par `/`.
 */
export function normalizeRemotePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/');
  const trailingSlash = raw.endsWith('/');
  const parts = raw.split('/').filter((segment) => segment !== '');
  if (parts.some((segment) => segment === '.' || segment === '..')) {
    throw new BadRequestError(`Chemin distant invalide : ${input}`);
  }
  if (parts.length === 0) return '/';
  const joined = `/${parts.join('/')}`;
  return trailingSlash ? `${joined}/` : joined;
}

/** Dernier segment d'un chemin (sans slash final). */
export function remoteBaseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

/** Dossier parent (avec slash final), `null` pour la racine. */
export function remoteParent(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}/`;
}
