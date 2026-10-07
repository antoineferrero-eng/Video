/** Analyse « tolérante » des dates et tailles telles qu'affichées par les index HTTP courants. */

const MONTHS: Record<string, number> = {
  jan: 0,
  janv: 0,
  january: 0,
  janvier: 0,
  feb: 1,
  fev: 1,
  fevr: 1,
  february: 1,
  fevrier: 1,
  mar: 2,
  mars: 2,
  march: 2,
  apr: 3,
  avr: 3,
  april: 3,
  avril: 3,
  may: 4,
  mai: 4,
  jun: 5,
  juin: 5,
  june: 5,
  jul: 6,
  juil: 6,
  july: 6,
  juillet: 6,
  aug: 7,
  aou: 7,
  aout: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  septembre: 8,
  oct: 9,
  october: 9,
  octobre: 9,
  nov: 10,
  november: 10,
  novembre: 10,
  dec: 11,
  december: 11,
  decembre: 11,
};

function monthIndex(raw: string): number | null {
  const key = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.$/, '');
  return MONTHS[key] ?? null;
}

function buildIso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  offsetMinutes = 0,
): string | null {
  if (year < 1980 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

interface DateMatch {
  iso: string;
  index: number;
  length: number;
}

type DatePattern = { regex: RegExp; build: (m: RegExpExecArray) => string | null };

const num = (value: string | undefined, fallback = 0) =>
  value === undefined ? fallback : Number(value);

const MONTH_WORD = '([A-Za-zÀ-ÿ]{3,9}\\.?)';

const DATE_PATTERNS: DatePattern[] = [
  {
    // 2025-10-07, 2025-10-07 09:12, 2025-10-07T09:12:00Z, 2025-10-07T09:12:00+02:00
    regex:
      /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/,
    build: (m) => {
      let offset = 0;
      if (m[7] && m[7] !== 'Z') {
        const sign = m[7].startsWith('-') ? -1 : 1;
        const digits = m[7].replace(/[^0-9]/g, '');
        offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      }
      return buildIso(num(m[1]), num(m[2]) - 1, num(m[3]), num(m[4]), num(m[5]), num(m[6]), offset);
    },
  },
  {
    // 2025/10/07 09:12
    regex: /(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
    build: (m) => buildIso(num(m[1]), num(m[2]) - 1, num(m[3]), num(m[4]), num(m[5]), num(m[6])),
  },
  {
    // nginx : 07-Oct-2025 09:12
    regex: new RegExp(
      `(\\d{1,2})-${MONTH_WORD}-(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?`,
    ),
    build: (m) => {
      const month = monthIndex(m[2] ?? '');
      return month === null
        ? null
        : buildIso(num(m[3]), month, num(m[1]), num(m[4]), num(m[5]), num(m[6]));
    },
  },
  {
    // 07 Oct 2025 09:12:00 (RFC 1123 « Tue, 07 Oct 2025 09:12:00 GMT »)
    regex: new RegExp(
      `(\\d{1,2})\\s+${MONTH_WORD}\\s+(\\d{4})(?:[\\s,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?`,
    ),
    build: (m) => {
      const month = monthIndex(m[2] ?? '');
      return month === null
        ? null
        : buildIso(num(m[3]), month, num(m[1]), num(m[4]), num(m[5]), num(m[6]));
    },
  },
  {
    // Oct 7, 2025 9:12 PM
    regex: new RegExp(
      `${MONTH_WORD}\\s+(\\d{1,2}),?\\s+(\\d{4})(?:[\\s,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AaPp][Mm])?)?`,
    ),
    build: (m) => {
      const month = monthIndex(m[1] ?? '');
      if (month === null) return null;
      let hour = num(m[4]);
      if (m[7]) {
        const pm = m[7].toLowerCase() === 'pm';
        if (pm && hour < 12) hour += 12;
        if (!pm && hour === 12) hour = 0;
      }
      return buildIso(num(m[3]), month, num(m[2]), hour, num(m[5]), num(m[6]));
    },
  },
  {
    // 07/10/2025 09:12 (jour/mois par défaut ; mois/jour avec AM/PM ou si nécessaire)
    regex:
      /(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/,
    build: (m) => {
      let day = num(m[1]);
      let month = num(m[2]);
      let hour = num(m[4]);
      const meridiem = m[7]?.toLowerCase();
      if (meridiem || (month > 12 && day <= 12)) [day, month] = [month, day];
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return buildIso(num(m[3]), month - 1, day, hour, num(m[5]), num(m[6]));
    },
  },
];

/** Cherche la première date reconnaissable dans un texte. */
export function findDate(text: string): DateMatch | null {
  let best: DateMatch | null = null;
  for (const { regex, build } of DATE_PATTERNS) {
    const match = regex.exec(text);
    if (!match) continue;
    const iso = build(match);
    if (!iso) continue;
    if (
      !best ||
      match.index < best.index ||
      (match.index === best.index && match[0].length > best.length)
    ) {
      best = { iso, index: match.index, length: match[0].length };
    }
  }
  return best;
}

/** Interprète une valeur de date (texte, ISO, timestamp Unix en secondes ou millisecondes). */
export function parseDateValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{10}(\.\d+)?$/.test(trimmed)) return buildIsoFromEpoch(Number(trimmed) * 1000);
  if (/^\d{13}$/.test(trimmed)) return buildIsoFromEpoch(Number(trimmed));
  return findDate(trimmed)?.iso ?? null;
}

function buildIsoFromEpoch(ms: number): string | null {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return year >= 1980 && year <= 2100 ? date.toISOString() : null;
}

const UNIT_POWER: Record<string, number> = { '': 0, b: 0, k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 };

function unitMultiplier(rawUnit: string | undefined): number | null {
  const unit = (rawUnit ?? '').toLowerCase();
  if (unit === '' || /^(b|o|bytes?|octets?)$/.test(unit)) return 1;
  const power = UNIT_POWER[unit[0] ?? ''];
  return power === undefined ? null : 1024 ** power;
}

function toNumber(raw: string): number {
  if (/^\d{1,3}(?:,\d{3}){2,}$/.test(raw)) return Number(raw.replace(/,/g, ''));
  return Number(raw.replace(',', '.'));
}

const SIZE_EXACT = /^\s*(\d+(?:[.,]\d+)*)\s*(bytes?|octets?|[kmgtpe](?:i?b|o)?|b|o)?\s*$/i;
const SIZE_LOOSE =
  /(?<![\w.,:/-])(\d+(?:[.,]\d+)?)\s?(bytes?|octets?|[kmgtpe](?:i?b|o)?|b|o)?(?![\w.,:/-])/gi;

/** Taille d'une cellule ne contenant qu'une taille (« 1.2G », « 734 Mo », « 123456 »). */
export function parseSizeExact(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = SIZE_EXACT.exec(text.replace(/\u00a0/g, ' '));
  if (!match?.[1]) return null;
  const multiplier = unitMultiplier(match[2]);
  if (multiplier === null) return null;
  const value = toNumber(match[1]);
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

/** Dernière taille trouvée dans un texte libre (ligne d'un listing `<pre>`). */
export function findSize(text: string): number | null {
  let result: number | null = null;
  for (const match of text.replace(/\u00a0/g, ' ').matchAll(SIZE_LOOSE)) {
    const multiplier = unitMultiplier(match[2]);
    if (multiplier === null || !match[1]) continue;
    const value = toNumber(match[1]);
    if (Number.isFinite(value)) result = Math.round(value * multiplier);
  }
  return result;
}
