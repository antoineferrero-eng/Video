export const VIDEO_EXTENSIONS = new Set([
  'mkv',
  'mp4',
  'm4v',
  'avi',
  'mov',
  'wmv',
  'webm',
  'ts',
  'm2ts',
  'mpg',
  'mpeg',
  'flv',
  'ogv',
  '3gp',
]);

export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa']);

export type FileCategory = 'video' | 'subtitle' | 'other';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function classifyFile(name: string): FileCategory {
  const ext = extensionOf(name);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  return 'other';
}

/** Fichiers d'échantillon (« sample ») livrés avec certaines releases. */
export function isSampleFile(name: string): boolean {
  return /(^|[\s._-])sample([\s._-]|$)/i.test(stripExtension(name));
}

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
};

export function videoMimeType(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

const LANGUAGE_TOKENS: Array<[RegExp, string]> = [
  [/^(fr|fre|fra|french|francais|français|vf|vff|vfq|vfi|vostfr|truefrench)$/i, 'fr'],
  [/^(en|eng|english|anglais)$/i, 'en'],
  [/^(es|spa|spanish|espanol|español)$/i, 'es'],
  [/^(de|ger|deu|german|deutsch)$/i, 'de'],
  [/^(it|ita|italian|italiano)$/i, 'it'],
  [/^(pt|por|pob|portuguese|pt-br|ptbr)$/i, 'pt'],
  [/^(nl|dut|nld|dutch)$/i, 'nl'],
  [/^(ar|ara|arabic)$/i, 'ar'],
  [/^(ja|jpn|japanese)$/i, 'ja'],
  [/^(ko|kor|korean)$/i, 'ko'],
  [/^(zh|chi|zho|chinese)$/i, 'zh'],
  [/^(ru|rus|russian)$/i, 'ru'],
];

/** Devine la langue d'un fichier de sous-titres à partir de son nom (« film.fr.srt », « VOSTFR.srt »…). */
export function guessSubtitleLanguage(fileName: string): string | null {
  const tokens = stripExtension(fileName)
    .split(/[\s._\-[\]()]+/)
    .filter(Boolean)
    .reverse();
  for (const token of tokens) {
    for (const [pattern, code] of LANGUAGE_TOKENS) {
      if (pattern.test(token)) return code;
    }
  }
  return null;
}

/** Normalise un code langue ISO 639-1/639-2 (« fre », « fra », « fr-FR ») en ISO 639-1. */
export function normalizeLanguageCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.toLowerCase().split(/[-_]/)[0] ?? '';
  if (base === 'und' || base === '') return null;
  for (const [pattern, iso] of LANGUAGE_TOKENS) {
    if (pattern.test(base)) return iso;
  }
  return base.length === 2 ? base : null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  fr: 'Français',
  en: 'Anglais',
  es: 'Espagnol',
  de: 'Allemand',
  it: 'Italien',
  pt: 'Portugais',
  nl: 'Néerlandais',
  ar: 'Arabe',
  ja: 'Japonais',
  ko: 'Coréen',
  zh: 'Chinois',
  ru: 'Russe',
};

export function languageLabel(code: string | null): string | null {
  if (!code) return null;
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}
