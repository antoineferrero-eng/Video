/** Décode un fichier texte en devinant son encodage (UTF-8/UTF-16 avec BOM, sinon Windows-1252). */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    // Nombreux sous-titres français encodés en Windows-1252 / ISO-8859-1.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Convertit un fichier SubRip (.srt) en WebVTT. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    // Horodatages : 00:01:02,345 → 00:01:02.345 (et heures sur un chiffre).
    .replace(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g,
      (_, h: string, m: string, s: string, ms: string) =>
        `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`,
    )
    // Balises de style ASS ({\an8}…) et <font> non supportées par WebVTT.
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '');
  return `WEBVTT\n\n${body}\n`;
}

/** Normalise un contenu déjà au format WebVTT. */
export function normalizeVtt(vtt: string): string {
  const text = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return text.startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`;
}

/** Codecs de sous-titres intégrés convertibles en texte (les formats image ne le sont pas). */
export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'text',
]);
