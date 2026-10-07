import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME_BYTES = 240;

/** Rend un nom de fichier/dossier sûr sur Windows, macOS et Linux. */
export function sanitizeFileName(name: string, fallback = 'sans-titre'): string {
  let result = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!result || result === '.' || result === '..') result = fallback;
  if (WINDOWS_RESERVED.test(result.split('.')[0] ?? '')) result = `_${result}`;
  if (Buffer.byteLength(result) > MAX_NAME_BYTES) {
    const ext = path.extname(result);
    let stem = result.slice(0, result.length - ext.length);
    while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
    result = stem.trimEnd() + ext;
  }
  return result;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Vérifie que `child` est strictement contenu dans `parent`. */
export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function fileSize(target: string): Promise<number | null> {
  try {
    const stats = await fs.stat(target);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export async function getDiskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    let existing = path.resolve(dir);
    while (!(await pathExists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
    const stats = await fs.statfs(existing);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** Renvoie un chemin libre en suffixant « (1) », « (2) »… si nécessaire. */
export async function uniquePath(target: string): Promise<string> {
  if (!(await pathExists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${stem} (${index})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Impossible de trouver un nom libre pour ${target}`);
}

/** Supprime les dossiers vides en remontant jusqu'à `stopAt` (exclu). */
export async function removeEmptyParents(startDir: string, stopAt: string): Promise<void> {
  let current = path.resolve(startDir);
  const root = path.resolve(stopAt);
  while (isPathInside(current, root)) {
    try {
      const content = await fs.readdir(current);
      if (content.length > 0) return;
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** Vérifie qu'un dossier existe (ou peut être créé) et est accessible en écriture. */
export async function assertWritableDir(dir: string): Promise<void> {
  await ensureDir(dir);
  await fs.access(dir, fsConstants.W_OK);
}
