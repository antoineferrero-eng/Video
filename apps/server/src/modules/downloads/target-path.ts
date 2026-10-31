import path from 'node:path';
import type { DownloadKind } from '@lumiere/shared';
import { isPathInside, sanitizeFileName } from '../../core/fs';
import { pad2 } from '../../core/text';
import { MOVIES_DIR, OTHER_DIR, SERIES_DIR } from '../library/library.service';
import { isOneFichierPath } from '../source/onefichier/onefichier-link';

export interface TargetPathInput {
  kind: DownloadKind;
  remotePath: string;
  fileName: string;
  /** Nom du dossier du titre (ex. « 100 METERS (2025) »). */
  titleFolder: string | null;
  season: number | null;
}

/**
 * Emplacement local d'un téléchargement :
 * - films  : `<racine>/Films/<Titre (Année)>/<fichier>`
 * - séries : `<racine>/Séries/<Série>/Saison 01/<fichier>`
 * - autres : `<racine>/Autres/<arborescence distante>` (`<racine>/Autres/<fichier>` pour un
 *   fichier 1fichier, dont le chemin n'a pas d'arborescence parlante)
 */
export function buildTargetPath(root: string, input: TargetPathInput): string {
  const file = sanitizeFileName(input.fileName, 'video');
  let target: string;
  if (input.kind === 'movie' && input.titleFolder) {
    target = path.join(root, MOVIES_DIR, sanitizeFileName(input.titleFolder), file);
  } else if (input.kind === 'episode' && input.titleFolder) {
    const seasonFolder =
      input.season === null
        ? 'Autres épisodes'
        : input.season === 0
          ? 'Spéciaux'
          : `Saison ${pad2(input.season)}`;
    target = path.join(root, SERIES_DIR, sanitizeFileName(input.titleFolder), seasonFolder, file);
  } else if (isOneFichierPath(input.remotePath)) {
    target = path.join(root, OTHER_DIR, file);
  } else {
    const segments = input.remotePath
      .split('/')
      .filter(Boolean)
      .slice(0, -1)
      .map((segment) => sanitizeFileName(segment));
    target = path.join(root, OTHER_DIR, ...segments, file);
  }
  if (!isPathInside(target, root))
    throw new Error(`Chemin cible hors du dossier de téléchargement : ${target}`);
  return target;
}
