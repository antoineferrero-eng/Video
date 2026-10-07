import { prettifyTitle } from '../core/text';
import { parseRelease } from './release-parser';

export interface ParsedTitle {
  title: string;
  year: number | null;
}

/**
 * Déduit titre et année d'un nom de dossier du catalogue.
 * Formats : « Titre (2020) », « Titre [2020] », « Titre.2020.1080p.WEB-DL… », « Titre ».
 */
export function parseFolderTitle(folderName: string): ParsedTitle {
  const name = folderName.trim().replace(/\/+$/, '');

  const bracketed = /^(.*?)[\s._-]*[([]((?:19|20)\d{2})[)\]]/.exec(name);
  if (bracketed?.[1]?.trim()) {
    return { title: prettifyTitle(cleanup(bracketed[1])), year: Number(bracketed[2]) };
  }

  const release = parseRelease(name);
  if (release.title) {
    return { title: prettifyTitle(release.title), year: release.year };
  }
  return { title: prettifyTitle(cleanup(name)), year: null };
}

function cleanup(raw: string): string {
  return raw.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}
