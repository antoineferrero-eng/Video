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

export function remoteInputArgs(isRemote: boolean, userAgent: string): string[] {
  if (!isRemote) return [];
  return [
    '-user_agent',
    userAgent,
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_on_network_error',
    '1',
    // Le relais répond 5xx quand la source refuse un instant (lien renouvelé, connexions…).
    '-reconnect_on_http_error',
    '5xx',
    '-reconnect_delay_max',
    '5',
    '-rw_timeout',
    '20000000',
  ];
}

/**
 * Filtre audio : trous comblés par du silence. Au début du fichier, l'audio démarre en plus
 * exactement avec la première image : une piste qui commence plus tard (retard d'une VF
 * d'une autre source…) est précédée de silence, une piste qui commence plus tôt est coupée.
 * Sans cela, le MP4 fragmenté place son premier échantillon à 0 suivi d'un trou, que le
 * navigateur referme : le son serait en avance d'autant jusqu'au premier positionnement.
 * Après un positionnement, audio et vidéo repartent déjà du même instant (image clé).
 */
function audioFilter({ start, plan }: StreamArgsInput): string {
  if (start > 0 || !plan.videoStream) return 'aresample=async=1';
  const rate = plan.audioStream?.sampleRate ?? 48_000;
  return `aresample=${rate}:async=1:first_pts=${Math.round(plan.videoStart * rate)}`;
}

/**
 * Arguments ffmpeg produisant un MP4 fragmenté lisible progressivement par le navigateur.
 * Le positionnement se fait en relançant ffmpeg avec `-ss` (seek rapide sur l'entrée).
 *
 * Vidéo recopiée : le flux repart forcément de l'image clé qui précède la position demandée.
 * L'audio repart alors du même instant (`-noaccurate_seek`) : le MP4 fragmenté fait démarrer
 * chaque piste à zéro, un audio coupé plus tard que la vidéo serait joué en avance. Une
 * seconde sortie (`framecrc` sur stderr, premier paquet vidéo seulement) donne l'instant
 * exact de cette image clé, lu par `readStreamOrigin`.
 */
export function buildStreamArgs(options: StreamArgsInput): string[] {
  const { plan } = options;
  const output = plan.output ?? { video: 'copy', audio: 'copy' };
  const copiedVideo = plan.videoStream && output.video === 'copy' ? plan.videoStream : null;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  args.push(...remoteInputArgs(options.isRemote, options.userAgent));
  if (options.start > 0) {
    args.push('-ss', options.start.toFixed(3));
    if (copiedVideo) args.push('-noaccurate_seek');
  }
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
    else {
      // Trous de l'audio source comblés par du silence : le navigateur les refermerait,
      // et l'audio garderait de l'avance sur l'image jusqu'au positionnement suivant.
      args.push('-af', audioFilter(options));
      if (output.audio === 'aac') args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
      else args.push('-c:a', 'libopus', '-ac', '2', '-b:a', '160k');
    }
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
    // Fragments courts : démarrage rapide même quand les images clés de la source sont espacées.
    '-frag_duration',
    '2000000',
    // En-tête écrit avec le premier fragment (`delay_moov`, pas `empty_moov`) : il peut alors
    // dire qu'une piste commence après l'autre (liste d'éditions). Sans cela, le premier
    // échantillon de chaque piste est ramené à 0 et suivi d'un trou, que le navigateur
    // referme pour l'audio : son en avance de l'écart (retard d'une piste, images B). Pas de
    // décalages de composition négatifs : avec des images B, ils avancent le son d'une image.
    '-movflags',
    'frag_keyframe+delay_moov+default_base_moof',
    'pipe:1',
  );
  if (copiedVideo) {
    args.push(
      '-map',
      `0:${copiedVideo.index}`,
      '-c',
      'copy',
      '-frames:v',
      '1',
      '-f',
      'framecrc',
      'pipe:2',
    );
  }
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
