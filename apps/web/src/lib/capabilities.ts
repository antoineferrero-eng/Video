import type { ClientCapabilities } from '@lumiere/shared';

let cached: ClientCapabilities | null = null;

function isChromium(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } })
    .userAgentData?.brands;
  if (brands)
    return brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(brand));
  return /Chrome\//.test(navigator.userAgent);
}

/**
 * Détecte les codecs que le navigateur sait décoder : le serveur s'en sert pour choisir
 * entre lecture directe, remultiplexage et transcodage.
 */
export function detectCapabilities(): ClientCapabilities {
  if (cached) return cached;
  const video = document.createElement('video');
  const supports = (type: string) =>
    video.canPlayType(type) !== '' ||
    (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type));

  const videoCodecs: string[] = [];
  if (supports('video/mp4; codecs="avc1.640028"')) videoCodecs.push('h264');
  if (
    supports('video/mp4; codecs="hvc1.1.6.L120.90"') ||
    supports('video/mp4; codecs="hev1.1.6.L120.90"')
  ) {
    videoCodecs.push('hevc');
  }
  if (supports('video/mp4; codecs="av01.0.08M.08"')) videoCodecs.push('av1');
  if (supports('video/webm; codecs="vp9"') || supports('video/mp4; codecs="vp09.00.10.08"'))
    videoCodecs.push('vp9');
  if (supports('video/webm; codecs="vp8"')) videoCodecs.push('vp8');

  const audioCodecs: string[] = [];
  if (supports('audio/mp4; codecs="mp4a.40.2"')) audioCodecs.push('aac');
  if (supports('audio/mpeg')) audioCodecs.push('mp3');
  if (supports('audio/webm; codecs="opus"') || supports('audio/mp4; codecs="opus"'))
    audioCodecs.push('opus');
  if (supports('audio/webm; codecs="vorbis"')) audioCodecs.push('vorbis');
  if (supports('audio/flac') || supports('audio/mp4; codecs="flac"')) audioCodecs.push('flac');
  if (supports('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
  if (supports('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');

  const containers = ['mp4'];
  if (supports('video/webm')) containers.push('webm');
  // Chrome/Edge lisent le Matroska (MKV) dès lors que les codecs sont compatibles.
  if (supports('video/x-matroska') || isChromium()) containers.push('mkv');

  cached = { videoCodecs, audioCodecs, containers };
  return cached;
}
