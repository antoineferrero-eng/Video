const STOP_WORDS = new Set([
  'and',
  'et',
  'the',
  'le',
  'la',
  'les',
  'de',
  'des',
  'du',
  'of',
  'a',
  'an',
  'l',
  'd',
]);

/** Normalise un texte pour la recherche : minuscules, sans accents ni ponctuation. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Découpe une requête utilisateur en mots-clés significatifs. */
export function searchTokens(query: string): string[] {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

/** Clé de tri alphabétique (ignore les articles initiaux courants). */
export function sortKey(title: string): string {
  return normalizeText(title).replace(/^(the|le|la|les|l|a|an) (?=\S)/, '');
}

const ROMAN_NUMERAL = /^(i{1,3}|iv|vi{0,3}|ix|xi{0,3})$/i;

/**
 * Met en forme un titre entièrement en majuscules (« 100 METERS » → « 100 Meters »).
 * Les titres contenant déjà des minuscules sont conservés tels quels.
 */
export function prettifyTitle(raw: string): string {
  const title = raw.trim();
  const letters = title.replace(/[^\p{L}]/gu, '');
  if (letters.length < 3 || letters !== letters.toUpperCase()) return title;
  return title
    .toLowerCase()
    .split(/(\s+)/)
    .map((word) => {
      if (ROMAN_NUMERAL.test(word)) return word.toUpperCase();
      return word.replace(
        /^([^\p{L}]*)(\p{L})/u,
        (_, prefix: string, letter: string) => prefix + letter.toUpperCase(),
      );
    })
    .join('')
    .replace(
      /([-–:'’(])(\p{Ll})/gu,
      (_, sep: string, letter: string) => sep + letter.toUpperCase(),
    );
}

/** Supprime les éléments entre crochets/parenthèses (hors année) pour une recherche TMDB plus fiable. */
export function stripBracketedTags(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?!(19|20)\d{2}\))[^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formate un code d'épisode : S01E02, S01E02-E03… */
export function formatEpisodeCode(
  season: number | null,
  episode: number | null,
  episodeEnd: number | null = null,
): string | null {
  if (episode === null) return season === null ? null : `S${pad2(season)}`;
  const base = season === null ? `E${pad2(episode)}` : `S${pad2(season)}E${pad2(episode)}`;
  return episodeEnd !== null && episodeEnd !== episode ? `${base}-E${pad2(episodeEnd)}` : base;
}

/** Taille lisible (« 1,4 Go ») pour les messages destinés à l'utilisateur. */
export function formatBytes(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: unit >= 3 ? 2 : 1 })} ${units[unit]}`;
}
