/**
 * Liens et chemins des fichiers 1fichier.
 *
 * Un lien 1fichier a la forme `https://<domaine>/?<identifiant>` (identifiant de 5 à 20
 * caractères alphanumériques). Dans Lumière, le fichier reçoit un chemin stable construit sur
 * cet identifiant, manipulé comme un chemin de la source par les téléchargements, la
 * bibliothèque et la lecture ; le lien direct n'est demandé à l'API qu'au moment de lire.
 *
 *   /@1fichier/a1b2c3d4e5/Film.2024.1080p.WEB-DL.mkv
 */

export const ONEFICHIER_ROOT = '/@1fichier/';

/** Domaines de 1fichier (documentation de l'API). */
const DOMAINS = [
  '1fichier.com',
  'alterupload.com',
  'cjoint.net',
  'desfichiers.com',
  'dfichiers.com',
  'megadl.fr',
  'mesfichiers.org',
  'piecejointe.net',
  'pjointe.com',
  'tenvoi.com',
];
const FILE_ID = /^[a-z0-9]{5,20}$/;

export interface OneFichierLink {
  /** Lien sous la seule forme acceptée par l'API (`https://<domaine>/?<identifiant>`). */
  url: string;
  fileId: string;
}

/** Lien 1fichier d'une adresse, sinon null (paramètres annexes comme `&af=` retirés). */
export function parseOneFichierUrl(input: string): OneFichierLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const domain = DOMAINS.find((item) => host === item || host.endsWith(`.${item}`));
  if (!domain) return null;
  // Forme courante : https://1fichier.com/?identifiant(&af=…)
  const query = url.search.slice(1).split('&')[0]?.split('=')[0]?.toLowerCase() ?? '';
  // Ancienne forme : https://identifiant.1fichier.com/
  const subdomain = host === domain ? '' : host.slice(0, -domain.length - 1);
  const fileId = FILE_ID.test(query) ? query : FILE_ID.test(subdomain) ? subdomain : null;
  return fileId ? { url: `https://${domain}/?${fileId}`, fileId } : null;
}

/** Premier lien 1fichier d'un texte copié (page, message, bouton « Copier » d'un site…). */
export function findOneFichierUrl(text: string): OneFichierLink | null {
  for (const candidate of text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) {
    const link = parseOneFichierUrl(candidate);
    if (link) return link;
  }
  return null;
}

export function isOneFichierPath(path: string): boolean {
  return path.startsWith(ONEFICHIER_ROOT);
}

export function oneFichierPath(fileId: string, fileName: string): string {
  return `${ONEFICHIER_ROOT}${fileId}/${fileName}`;
}

export function parseOneFichierPath(path: string): { fileId: string; fileName: string } | null {
  if (!isOneFichierPath(path)) return null;
  const [fileId, fileName] = path.slice(ONEFICHIER_ROOT.length).split('/');
  if (!fileId || !FILE_ID.test(fileId) || !fileName) return null;
  return { fileId, fileName };
}
