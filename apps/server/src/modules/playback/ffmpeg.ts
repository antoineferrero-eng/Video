import { spawn } from 'node:child_process';
import { ServiceUnavailableError, UpstreamError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { normalizeLanguageCode } from '../../domain/media-files';

export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'attachment' | 'data' | 'unknown';
  codec: string | null;
  profile: string | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isAttachedPicture: boolean;
  colorTransfer: string | null;
  bitDepth: number | null;
  /** Instant de la première image ou du premier échantillon, en secondes. */
  startTime: number | null;
  /** Fréquence d'échantillonnage (audio), en Hz. */
  sampleRate: number | null;
  /** Images par seconde (vidéo). */
  frameRate: number | null;
}

export interface ProbeResult {
  formatName: string;
  /** Départ du fichier (la plus précoce des pistes) : ffmpeg compte le temps à partir de lui. */
  startTime: number | null;
  duration: number | null;
  bitRate: number | null;
  size: number | null;
  streams: ProbeStream[];
}

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  channels?: number;
  color_transfer?: string;
  bits_per_raw_sample?: string;
  start_time?: string;
  sample_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

interface RawProbe {
  format?: {
    format_name?: string;
    start_time?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
  };
  streams?: RawStream[];
}

export interface FfmpegCapabilities {
  available: boolean;
  ffprobeAvailable: boolean;
  version: string | null;
  hasZscale: boolean;
  hasLibx264: boolean;
  hasLibvpxVp9: boolean;
  hasLibopus: boolean;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Accès aux binaires ffmpeg/ffprobe (détection des capacités, analyse des médias). */
export class Ffmpeg {
  private capabilities: FfmpegCapabilities = {
    available: false,
    ffprobeAvailable: false,
    version: null,
    hasZscale: false,
    hasLibx264: false,
    hasLibvpxVp9: false,
    hasLibopus: false,
  };

  constructor(
    readonly ffmpegPath: string,
    readonly ffprobePath: string,
    private readonly logger: Logger,
  ) {}

  get info(): FfmpegCapabilities {
    return this.capabilities;
  }

  async detect(): Promise<FfmpegCapabilities> {
    const caps: FfmpegCapabilities = { ...this.capabilities };
    try {
      const version = await run(this.ffmpegPath, ['-hide_banner', '-version'], 10_000);
      caps.available = version.code === 0;
      caps.version = /ffmpeg version (\S+)/.exec(version.stdout)?.[1] ?? null;
      if (caps.available) {
        const [filters, encoders] = await Promise.all([
          run(this.ffmpegPath, ['-hide_banner', '-filters'], 10_000),
          run(this.ffmpegPath, ['-hide_banner', '-encoders'], 10_000),
        ]);
        caps.hasZscale = /\szscale\s/.test(filters.stdout);
        caps.hasLibx264 = /\slibx264\s/.test(encoders.stdout);
        caps.hasLibvpxVp9 = /\slibvpx-vp9\s/.test(encoders.stdout);
        caps.hasLibopus = /\slibopus\s/.test(encoders.stdout);
      }
    } catch {
      caps.available = false;
    }
    try {
      caps.ffprobeAvailable =
        (await run(this.ffprobePath, ['-hide_banner', '-version'], 10_000)).code === 0;
    } catch {
      caps.ffprobeAvailable = false;
    }
    this.capabilities = caps;
    if (!caps.available || !caps.ffprobeAvailable) {
      this.logger.warn(
        'ffmpeg/ffprobe introuvable : la lecture se limitera aux fichiers directement compatibles avec le navigateur.',
      );
    } else {
      this.logger.info({ version: caps.version }, 'ffmpeg détecté');
    }
    return caps;
  }

  /** Analyse un fichier local ou une URL distante. */
  async probe(input: string, options: { userAgent?: string } = {}): Promise<ProbeResult> {
    if (!this.capabilities.ffprobeAvailable) {
      throw new ServiceUnavailableError('FFPROBE_UNAVAILABLE', 'ffprobe est introuvable.');
    }
    const isRemote = /^https?:\/\//i.test(input);
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
    if (isRemote) {
      args.push('-rw_timeout', '20000000');
      if (options.userAgent) args.push('-user_agent', options.userAgent);
    }
    args.push(input);
    const result = await run(this.ffprobePath, args, 60_000);
    if (result.code !== 0) {
      throw new UpstreamError(
        `Analyse du média impossible : ${result.stderr.trim().split('\n').at(-1) ?? 'erreur ffprobe'}`,
      );
    }
    return parseProbe(JSON.parse(result.stdout) as RawProbe);
  }
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fraction ffprobe (« 24000/1001 ») en nombre ; « 0/0 » (inconnu) donne null. */
function toRate(value: string | undefined): number | null {
  const [numerator, denominator = '1'] = (value ?? '').split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function parseProbe(raw: RawProbe): ProbeResult {
  const streams = (raw.streams ?? []).map((stream): ProbeStream => {
    const type = (['video', 'audio', 'subtitle', 'attachment', 'data'] as const).find(
      (candidate) => candidate === stream.codec_type,
    );
    const tags = Object.fromEntries(
      Object.entries(stream.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const pixFmt = stream.pix_fmt ?? null;
    const bitDepth =
      toNumber(stream.bits_per_raw_sample) ??
      (pixFmt && /(10|12)(le|be)$/.test(pixFmt)
        ? Number(/(10|12)(le|be)$/.exec(pixFmt)?.[1])
        : null);
    return {
      index: stream.index,
      type: type ?? 'unknown',
      codec: stream.codec_name ?? null,
      profile: stream.profile ?? null,
      pixFmt,
      width: stream.width ?? null,
      height: stream.height ?? null,
      channels: stream.channels ?? null,
      language: normalizeLanguageCode(tags.language),
      title: tags.title ?? null,
      isDefault: stream.disposition?.default === 1,
      isForced: stream.disposition?.forced === 1,
      isAttachedPicture: stream.disposition?.attached_pic === 1,
      colorTransfer: stream.color_transfer ?? null,
      bitDepth,
      startTime: toNumber(stream.start_time),
      sampleRate: toNumber(stream.sample_rate),
      // Cadence moyenne d'abord : `r_frame_rate` vaut parfois le double (champs entrelacés).
      frameRate: toRate(stream.avg_frame_rate) ?? toRate(stream.r_frame_rate),
    };
  });
  return {
    formatName: raw.format?.format_name ?? '',
    startTime: toNumber(raw.format?.start_time),
    duration: toNumber(raw.format?.duration),
    bitRate: toNumber(raw.format?.bit_rate),
    size: toNumber(raw.format?.size),
    streams,
  };
}
