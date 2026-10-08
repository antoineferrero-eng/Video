/** Plage d’octets [start, end[ (fin exclue). */
export type Span = [start: number, end: number];

/**
 * Ensemble de plages d'octets déjà reçues, triées et fusionnées : un fichier téléchargé en
 * plusieurs morceaux simultanés a des trous jusqu'à la fin.
 */
export class ByteRanges {
  private ranges: Span[] = [];

  constructor(ranges: Span[] = []) {
    for (const [start, end] of ranges) this.add(start, end);
  }

  add(start: number, end: number): void {
    if (!(end > start)) return;
    const merged: Span[] = [];
    let current: Span = [start, end];
    let placed = false;
    for (const range of this.ranges) {
      if (range[1] < current[0]) merged.push(range);
      else if (range[0] > current[1]) {
        if (!placed) merged.push(current);
        placed = true;
        merged.push(range);
      } else current = [Math.min(range[0], current[0]), Math.max(range[1], current[1])];
    }
    if (!placed) merged.push(current);
    this.ranges = merged;
  }

  /** Nombre d'octets couverts. */
  get size(): number {
    return this.ranges.reduce((total, [start, end]) => total + end - start, 0);
  }

  /** Premier octet manquant à partir de `from`. */
  firstMissing(from = 0): number {
    let position = from;
    for (const [start, end] of this.ranges) {
      if (start > position) break;
      if (end > position) position = end;
    }
    return position;
  }

  /** Début de la première plage reçue après `position` (fin d'un trou), sinon null. */
  nextCovered(position: number): number | null {
    return this.ranges.find(([start]) => start > position)?.[0] ?? null;
  }

  /** Trous jusqu'à `total`. */
  gaps(total: number): Span[] {
    const gaps: Span[] = [];
    let position = 0;
    for (const [start, end] of this.ranges) {
      if (start >= total) break;
      if (start > position) gaps.push([position, start]);
      position = Math.max(position, end);
    }
    if (position < total) gaps.push([position, total]);
    return gaps;
  }

  /** Ne garde que ce qui est avant `limit` (fichier plus court que prévu). */
  clamp(limit: number): void {
    this.ranges = this.ranges
      .filter(([start]) => start < limit)
      .map(([start, end]): Span => [start, Math.min(end, limit)]);
  }

  toJSON(): Span[] {
    return this.ranges.map(([start, end]): Span => [start, end]);
  }
}
