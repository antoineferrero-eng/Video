/** Plage d'octets inclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Interprète un en-tête `Range` (une seule plage supportée).
 * - `null` : pas de plage exploitable → contenu complet ;
 * - `'unsatisfiable'` : plage hors limites → réponse 416.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Extrait la taille totale d'un en-tête `Content-Range: bytes 0-99/1234`. */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  return match?.[1] ? Number(match[1]) : null;
}

/** Extrait le début d'un en-tête `Content-Range: bytes 100-199/1234`. */
export function parseContentRangeStart(header: string | null): number | null {
  if (!header) return null;
  const match = /bytes\s+(\d+)-/.exec(header);
  return match?.[1] ? Number(match[1]) : null;
}
