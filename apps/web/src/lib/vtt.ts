export interface Cue {
  start: number;
  end: number;
  /** HTML assaini : seules les balises <i>, <b>, <u> et <br> sont conservées. */
  html: string;
}

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function parseTimestamp(value: string): number {
  const [clock = '0', fraction = '0'] = value.replace(',', '.').split('.');
  const parts = clock.split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds + Number(`0.${fraction}`);
}

function sanitize(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/&lt;(\/?)(i|b|u)(?:\.[^&]*)?&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?[^&]*&gt;/g, '')
    .replace(/\n/g, '<br>');
}

/** Analyse un fichier WebVTT en liste de répliques. */
export function parseVtt(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue;
    const match = TIMING.exec(lines[timingIndex] ?? '');
    if (!match?.[1] || !match[2]) continue;
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (!text) continue;
    cues.push({
      start: parseTimestamp(match[1]),
      end: parseTimestamp(match[2]),
      html: sanitize(text),
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Répliques actives à un instant donné. */
export function activeCues(cues: Cue[], time: number): Cue[] {
  return cues.filter((cue) => cue.start <= time && time < cue.end);
}
