import type { CustomSource, TitleDetails } from '@lumiere/shared';

/**
 * Domaines de 1fichier (documentation de l'API) : le serveur reconnaît les mêmes
 * (apps/server/src/modules/source/onefichier/onefichier-link.ts).
 */
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

/** Lien 1fichier (https://domaine/?identifiant), aussi utilisé tel quel dans le favori. */
const LINK_PATTERN = `https?://(?:[a-z0-9-]+\\.)*(?:${DOMAINS.map((domain) => domain.replace(/\./g, '\\.')).join('|')})/\\?[a-z0-9]{5,20}[^\\s"'<>]*`;

/** Premier lien 1fichier d'un texte copié, sinon null. */
export function findOneFichierLink(text: string): string | null {
  return new RegExp(LINK_PATTERN, 'i').exec(text)?.[0] ?? null;
}

/**
 * Adresse d'une source personnalisée pour un titre : repères remplacés ({titre},
 * {titre_original}, {annee}, {tmdb}, {imdb}, {type}, {type_en}).
 */
export function customSourceUrl(source: CustomSource, title: TitleDetails): string {
  const values: Record<string, string> = {
    titre: title.title,
    titre_original: title.originalTitle ?? title.title,
    annee: title.year ? String(title.year) : '',
    tmdb: title.tmdbId ? String(title.tmdbId) : '',
    imdb: title.imdbId ?? '',
    type: title.kind === 'movie' ? 'film' : 'serie',
    type_en: title.kind === 'movie' ? 'movie' : 'series',
  };
  return source.searchUrl.replace(/\{([a-z_]+)\}/g, (marker, name: string) =>
    name in values ? encodeURIComponent(values[name] as string) : marker,
  );
}

/** loadix.fun : sa page de recherche lit le titre (`q`) et le type (`movie` ou `series`). */
export const LOADIX_SEARCH_URL = 'https://loadix.fun/search?q={titre}&type={type_en}';

/** L'adresse contient-elle au moins un repère ({titre}…) ? Sinon le site s'ouvre tel quel. */
export function hasMarkers(searchUrl: string): boolean {
  return /\{[a-z_]+\}/.test(searchUrl);
}

/** Page de Lumière qui reçoit le lien envoyé par le favori (lien dans le fragment « # »). */
export const SEND_PATH = '/envoi-1fichier';

/**
 * Code du favori « Envoyer à Lumière » : sur la page 1fichier, il envoie son adresse ; sur une
 * autre page (celle du site où le lien est affiché), le premier lien 1fichier qu'elle contient.
 * Le lien est lu dans le navigateur de l'utilisateur, au clic sur le favori.
 */
export function bookmarkletCode(origin: string): string {
  const script = `(()=>{const r=new RegExp(${JSON.stringify(LINK_PATTERN)},'i');let u=r.test(location.href)?location.href:'';if(!u){const a=[...document.querySelectorAll('a[href]')].map((e)=>e.href).find((h)=>r.test(h));u=a||(r.exec(document.body.innerText)||[''])[0]}window.open(${JSON.stringify(`${origin}${SEND_PATH}#`)}+encodeURIComponent(u),'_blank')})()`;
  // Encodé : le navigateur décode l'adresse « javascript: » avant de l'exécuter (« # », « % »…).
  return `javascript:${encodeURIComponent(script)}`;
}
