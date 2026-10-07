import type { TranscodePreset } from '@lumiere/shared';
import type { PlaybackPlan } from './planner';

export interface StreamArgsInput {
  input: string;
  isRemote: boolean;
  userAgent: string;
  start: number;
  plan: PlaybackPlan;
  preset: TranscodePreset;
  maxHeight: number;
  canTonemap: boolean;
}

const X264_PRESETS: Record<TranscodePreset, { preset: string; crf: number }> = {
  quality: { preset: 'faster', crf: 20 },
  balanced: { preset: 'veryfast', crf: 22 },
  fast: { preset: 'superfast', crf: 24 },
};

function remoteInputArgs(isRemote: boolean, userAgent: string): string[] {
  if (!isRemote) return [];
  return [
    '-user_agent',
    userAgent,
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-rw_timeout',
    '20000000',
  ];
}

/**
 * Arguments ffmpeg produisant un MP4 fragmenté lisible progressivement par le navigateur.
 * Le positionnement se fait en relançant ffmpeg avec `-ss` (seek rapide sur l'entrée).
 */
export function buildStreamArgs(options: StreamArgsInput): string[] {
  const { plan } = options;
  const output = plan.output ?? { video: 'copy', audio: 'copy' };
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  args.push(...remoteInputArgs(options.isRemote, options.userAgent));
  if (options.start > 0) args.push('-ss', options.start.toFixed(3));
  args.push('-i', options.input);

  if (plan.videoStream) args.push('-map', `0:${plan.videoStream.index}`);
  if (plan.audioStream) args.push('-map', `0:${plan.audioStream.index}`);

  if (plan.videoStream) {
    if (output.video === 'copy') {
      args.push('-c:v', 'copy');
      if (plan.videoStream.codec === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      const filters: string[] = [];
      if (plan.hdr && options.canTonemap) {
        filters.push(
          'zscale=t=linear:npl=100',
          'format=gbrpf32le',
          'zscale=p=bt709',
          'tonemap=tonemap=hable:desat=0',
          'zscale=t=bt709:m=bt709:r=tv',
        );
      }
      filters.push(`scale=-2:'min(${options.maxHeight},ih)'`, 'format=yuv420p');
      args.push('-vf', filters.join(','));
      if (output.video === 'h264') {
        const { preset, crf } = X264_PRESETS[options.preset];
        args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high');
      } else {
        args.push(
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-row-mt',
          '1',
          '-b:v',
          '0',
          '-crf',
          '34',
        );
      }
      args.push('-force_key_frames', 'expr:gte(t,n_forced*2)');
    }
  }

  if (plan.audioStream) {
    if (output.audio === 'copy') args.push('-c:a', 'copy');
    else if (output.audio === 'aac') args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    else args.push('-c:a', 'libopus', '-ac', '2', '-b:a', '160k');
  }

  args.push(
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-avoid_negative_ts',
    'make_zero',
    '-max_muxing_queue_size',
    '4096',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}

/** Extraction d'une piste de sous-titres texte intégrée, convertie en WebVTT. */
export function buildSubtitleExtractArgs(
  input: string,
  streamIndex: number,
  isRemote: boolean,
  userAgent: string,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...remoteInputArgs(isRemote, userAgent),
    '-i',
    input,
    '-map',
    `0:${streamIndex}`,
    '-f',
    'webvtt',
    'pipe:1',
  ];
}

/** Conversion d'un fichier de sous-titres (ASS/SSA…) reçu sur l'entrée standard. */
export function buildSubtitleConvertArgs(format: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    format,
    '-i',
    'pipe:0',
    '-f',
    'webvtt',
    'pipe:1',
  ];
}
