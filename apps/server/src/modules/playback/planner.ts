import type { ClientCapabilities, PlaybackMode } from '@lumiere/shared';
import type { ProbeResult, ProbeStream } from './ffmpeg';

export type OutputVideoCodec = 'copy' | 'h264' | 'vp9';
export type OutputAudioCodec = 'copy' | 'aac' | 'opus';

export interface PlaybackPlan {
  mode: PlaybackMode;
  container: string;
  videoStream: ProbeStream | null;
  audioStream: ProbeStream | null;
  audioStreams: ProbeStream[];
  /** Index (parmi les pistes audio) de la piste lue. */
  audioTrack: number | null;
  output: { video: OutputVideoCodec; audio: OutputAudioCodec } | null;
  hdr: boolean;
  reasons: string[];
}

export interface PlanOptions {
  extension: string;
  audioTrack: number | null;
  preferredAudioLanguage: string;
  forceTranscode: boolean;
  canEncodeH264: boolean;
  canEncodeVp9: boolean;
}

const VIDEO_CODECS: Record<string, string> = {
  h264: 'h264',
  hevc: 'hevc',
  av1: 'av1',
  vp9: 'vp9',
  vp8: 'vp8',
};

const AUDIO_CODECS: Record<string, string> = {
  aac: 'aac',
  mp3: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3',
  dts: 'dts',
  truehd: 'truehd',
};

/** Codecs audio qu'on sait recopier tels quels dans un MP4 fragmenté. */
const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'opus', 'flac']);

export function normalizeVideoCodec(codec: string | null): string | null {
  return codec ? (VIDEO_CODECS[codec] ?? null) : null;
}

export function normalizeAudioCodec(codec: string | null): string | null {
  if (!codec) return null;
  if (codec.startsWith('pcm_')) return 'pcm';
  return AUDIO_CODECS[codec] ?? null;
}

export function containerOf(formatName: string, extension: string): string {
  if (formatName.includes('mp4') || formatName.includes('mov')) return 'mp4';
  if (formatName.includes('matroska') || formatName.includes('webm'))
    return extension === 'webm' ? 'webm' : 'mkv';
  if (formatName.includes('avi')) return 'avi';
  if (formatName.includes('mpegts')) return 'ts';
  return extension || formatName;
}

export function isHdr(stream: ProbeStream | null): boolean {
  return !!stream && ['smpte2084', 'arib-std-b67'].includes(stream.colorTransfer ?? '');
}

function videoSupported(stream: ProbeStream, caps: ClientCapabilities): boolean {
  const codec = normalizeVideoCodec(stream.codec);
  if (!codec || !caps.videoCodecs.includes(codec)) return false;
  if (codec === 'h264') {
    // Les navigateurs ne décodent pas le H.264 10 bits / 4:2:2 / 4:4:4.
    if ((stream.bitDepth ?? 8) > 8) return false;
    if (/high 10|high 4:2:2|high 4:4:4/i.test(stream.profile ?? '')) return false;
    if (/422|444/.test(stream.pixFmt ?? '')) return false;
  }
  return true;
}

function audioSupported(stream: ProbeStream, caps: ClientCapabilities): boolean {
  const codec = normalizeAudioCodec(stream.codec);
  return !!codec && caps.audioCodecs.includes(codec);
}

/** Piste audio par défaut : choix explicite, sinon langue préférée, sinon piste « default », sinon la première. */
export function chooseAudioTrack(
  audioStreams: ProbeStream[],
  requested: number | null,
  preferredLanguage: string,
): number | null {
  if (audioStreams.length === 0) return null;
  if (requested !== null && requested >= 0 && requested < audioStreams.length) return requested;
  if (preferredLanguage) {
    const preferred = audioStreams.findIndex((stream) => stream.language === preferredLanguage);
    if (preferred >= 0) return preferred;
  }
  const flagged = audioStreams.findIndex((stream) => stream.isDefault);
  return flagged >= 0 ? flagged : 0;
}

/**
 * Décide comment lire un média dans le navigateur :
 * lecture directe si possible, sinon remultiplexage (vidéo copiée), sinon transcodage.
 */
export function planPlayback(
  probe: ProbeResult,
  caps: ClientCapabilities,
  options: PlanOptions,
): PlaybackPlan {
  const videoStream =
    probe.streams.find((stream) => stream.type === 'video' && !stream.isAttachedPicture) ?? null;
  const audioStreams = probe.streams.filter((stream) => stream.type === 'audio');
  const audioTrack = chooseAudioTrack(
    audioStreams,
    options.audioTrack,
    options.preferredAudioLanguage,
  );
  const audioStream = audioTrack === null ? null : (audioStreams[audioTrack] ?? null);
  const container = containerOf(probe.formatName, options.extension);
  const reasons: string[] = [];

  const videoOk = !videoStream || videoSupported(videoStream, caps);
  const audioOk = !audioStream || audioSupported(audioStream, caps);
  let containerOk = caps.containers.includes(container);
  if (container === 'webm') {
    containerOk &&=
      (!videoStream ||
        ['vp8', 'vp9', 'av1'].includes(normalizeVideoCodec(videoStream.codec) ?? '')) &&
      (!audioStream || ['opus', 'vorbis'].includes(normalizeAudioCodec(audioStream.codec) ?? ''));
  }
  const firstAudio = audioTrack === null || audioTrack === 0;

  if (!videoOk)
    reasons.push(
      `Vidéo ${videoStream?.codec ?? '?'}${(videoStream?.bitDepth ?? 8) > 8 ? ' 10 bits' : ''} non décodable par le navigateur`,
    );
  if (!audioOk)
    reasons.push(`Audio ${audioStream?.codec ?? '?'} non pris en charge par le navigateur`);
  if (!containerOk) reasons.push(`Conteneur ${container.toUpperCase()} non lisible directement`);
  if (!firstAudio) reasons.push('Piste audio secondaire sélectionnée');
  if (options.forceTranscode) reasons.push('Conversion forcée');

  const base = {
    container,
    videoStream,
    audioStream,
    audioStreams,
    audioTrack,
    hdr: isHdr(videoStream),
  };

  if (!options.forceTranscode && videoOk && audioOk && containerOk && firstAudio) {
    return {
      ...base,
      mode: 'direct',
      output: null,
      reasons: ['Lecture directe du fichier original'],
    };
  }

  const audioCodec = audioStream ? normalizeAudioCodec(audioStream.codec) : null;
  const outputAudio: OutputAudioCodec = !audioStream
    ? 'copy'
    : audioOk && audioCodec && MP4_AUDIO_COPY.has(audioCodec)
      ? 'copy'
      : caps.audioCodecs.includes('aac')
        ? 'aac'
        : 'opus';

  if (!options.forceTranscode && videoStream && videoOk) {
    return { ...base, mode: 'remux', output: { video: 'copy', audio: outputAudio }, reasons };
  }

  const outputVideo: OutputVideoCodec =
    caps.videoCodecs.includes('h264') && options.canEncodeH264
      ? 'h264'
      : caps.videoCodecs.includes('vp9') && options.canEncodeVp9
        ? 'vp9'
        : 'h264';
  return {
    ...base,
    mode: 'transcode',
    output: {
      video: videoStream ? outputVideo : 'copy',
      audio:
        outputAudio === 'copy' && options.forceTranscode
          ? caps.audioCodecs.includes('aac')
            ? 'aac'
            : 'opus'
          : outputAudio,
    },
    reasons,
  };
}
