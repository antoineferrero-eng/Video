import { BadRequestError } from '../../core/errors';

/**
 * Les chemins distants sont manipulés sous forme décodée, relatifs à la racine de la source :
 * `/movies/Titre (2020)/fichier.mkv`. Les dossiers se terminent par `/`.
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

export function normalizeDirPath(input: string): string {
  const normalized = normalizeRemotePath(input);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function isDirPath(path: string): boolean {
  return path.endsWith('/');
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

export function joinRemote(dir: string, name: string, isDirectory: boolean): string {
  const base = normalizeDirPath(dir);
  return `${base}${name}${isDirectory ? '/' : ''}`;
}

/** Vérifie que `path` est situé dans `dir` (ou est `dir` lui-même). */
export function isRemotePathWithin(path: string, dir: string): boolean {
  return normalizeRemotePath(path).startsWith(normalizeDirPath(dir));
}
