const TIME_BASE = /^#tb 0: (\d+)\/(\d+)\s*$/;
const PACKET = /^0,\s*(-?\d+),\s*(-?\d+),\s*-?\d+,\s*\d+,\s*0x[0-9a-f]+/i;
/** AV_NOPTS_VALUE tel qu'imprimé par framecrc. */
const NO_TIMESTAMP = '-9223372036854775808';
const MAX_LOG_CHARS = 4000;

/**
 * Lit la sortie d'erreur d'un ffmpeg lancé par `buildStreamArgs`. Elle mêle le journal
 * (erreurs) et, quand la vidéo est recopiée, la sortie `framecrc` du premier paquet vidéo :
 * son horodatage, relatif à la position demandée, donne l'instant de la source où démarre
 * le temps du flux. C'est l'instant de décodage de l'image clé atteinte : le flux part de
 * lui (`make_zero`), et l'image clé s'affiche un peu après quand la vidéo a des images B.
 * Il peut donc précéder le début du fichier de quelques centièmes de seconde.
 */
export class StreamOriginReader {
  private pending = '';
  private timeBase: number | null = null;
  private found = false;
  /** Fin du journal d'erreurs de ffmpeg (diagnostic). */
  log = '';

  constructor(
    /** Position demandée à ffmpeg (`-ss`), en secondes. */
    private readonly start: number,
    private readonly onOrigin: (origin: number) => void,
  ) {}

  push(chunk: string): void {
    const lines = (this.pending + chunk).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line.replace(/\r$/, ''));
  }

  /** Dernière ligne utile du journal (message d'erreur à afficher). */
  get lastError(): string | null {
    const lines = `${this.log}\n${this.pending}`.trim().split('\n');
    return lines.at(-1)?.trim() || null;
  }

  private line(line: string): void {
    const timeBase = TIME_BASE.exec(line);
    if (timeBase) {
      this.timeBase = Number(timeBase[1]) / Number(timeBase[2]);
      return;
    }
    if (line.startsWith('#')) return;
    const packet = PACKET.exec(line);
    if (packet) {
      if (this.found || this.timeBase === null) return;
      const [, dts = '', pts = ''] = packet;
      const timestamp = dts !== NO_TIMESTAMP ? dts : pts;
      if (timestamp === NO_TIMESTAMP) return;
      const value = Number(timestamp);
      this.found = true;
      this.onOrigin(this.start + value * this.timeBase);
      return;
    }
    if (line.trim()) this.log = `${this.log}${line}\n`.slice(-MAX_LOG_CHARS);
  }
}
