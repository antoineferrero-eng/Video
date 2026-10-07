/**
 * Noms de dossiers probables d'un titre sur la source, quand la liste complète n'est pas
 * accessible. Les index comme a.111477.xyz suivent les conventions des gestionnaires de
 * médiathèque : Radarr range un film dans « Titre (Année) », Sonarr une série dans
 * « Titre » (parfois « Titre (Année) »), avec les caractères interdits remplacés.
 * Faute de liste, on devine : les propositions vont de la plus probable à la moins probable.
 */

export interface FolderNameQuery {
  kind: 'movie' | 'series';
  /** Titres connus, du plus probable au moins probable (anglais, original, traduit). */
  titles: string[];
  year: number | null;
  /** Nombre maximal de propositions (chaque essai coûte une requête). */
  limit?: number;
}

/** Écritures sans lettres latines : un dossier nommé ainsi est très improbable. */
const NON_LATIN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}]/u;

/** Caractères interdits dans un nom de fichier, remplacés comme le font Radarr et Sonarr. */
function replaceIllegal(name: string): string {
  return name
    .replace(/[\\/]/g, '+')
    .replace(/[<>"|]/g, '')
    .replace(/\*/g, '-');
}

function tidy(name: string): string {
  // Espaces multiples réduits ; ni espace ni point en fin de nom (interdit sous Windows).
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** Variantes d'un titre, la plus courante d'abord (deux-points supprimés, « - », « -  »…). */
export function titleVariants(title: string): string[] {
  const base = tidy(title.normalize('NFC'));
  if (!base) return [];
  const forms = base.includes(':')
    ? [base.replace(/:/g, ''), base.replace(/\s*:\s*/g, ' - '), base.replace(/:/g, '-')]
    : [base];
  const variants: string[] = [];
  for (const form of forms) {
    const cleaned = tidy(replaceIllegal(form));
    if (cleaned.includes('?')) {
      variants.push(tidy(cleaned.replace(/\?/g, '')), tidy(cleaned.replace(/\?/g, '!')));
    } else {
      variants.push(cleaned);
    }
  }
  return [...new Set(variants.filter(Boolean))];
}

export function folderCandidates(query: FolderNameQuery): string[] {
  const names = [...new Set(query.titles.map((title) => title.trim()).filter(Boolean))].filter(
    (title) => !NON_LATIN.test(title),
  );
  const variants = names.map(titleVariants).filter((list) => list.length > 0);
  const first = variants[0]?.[0];
  if (!first) return [];
  const candidates: string[] = [];
  const add = (name: string) => {
    if (!candidates.includes(name)) candidates.push(name);
  };
  const { year } = query;
  if (query.kind === 'movie') {
    const withYear = (name: string) => (year ? `${name} (${year})` : name);
    for (const list of variants) add(withYear(list[0] as string));
    for (const list of variants) list.slice(1).forEach((name) => add(withYear(name)));
    // Certains dossiers sont en capitales (« 100 METERS (2025) »).
    add(withYear(first.toUpperCase()));
    if (year) {
      // L'année de sortie varie parfois d'un pays à l'autre.
      add(`${first} (${year - 1})`);
      add(`${first} (${year + 1})`);
    }
  } else {
    for (const list of variants) add(list[0] as string);
    // Sonarr ajoute l'année pour distinguer les homonymes (« Doctor Who (2005) »).
    if (year) for (const list of variants) add(`${list[0] as string} (${year})`);
    for (const list of variants) list.slice(1).forEach(add);
    add(first.toUpperCase());
  }
  return candidates.slice(0, query.limit ?? 8);
}
