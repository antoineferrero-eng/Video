import { describe, expect, it } from 'vitest';
import type { ClientCapabilities } from '@lumiere/shared';
import type { ProbeResult, ProbeStream } from '../src/modules/playback/ffmpeg';
import { buildStreamArgs } from '../src/modules/playback/ffmpeg-args';
import { planPlayback, type PlanOptions } from '../src/modules/playback/planner';
import { StreamOriginReader } from '../src/modules/playback/stream-origin';
import { decodeText, srtToVtt } from '../src/modules/playback/subtitles';

const CHROME: ClientCapabilities = {
  videoCodecs: ['h264', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
  containers: ['mp4', 'webm', 'mkv'],
};
const NO_PROPRIETARY: ClientCapabilities = {
  videoCodecs: ['vp9', 'av1'],
  audioCodecs: ['opus', 'mp3'],
  containers: ['mp4', 'webm'],
};

function stream(
  partial: Partial<ProbeStream> & Pick<ProbeStream, 'index' | 'type' | 'codec'>,
): ProbeStream {
  return {
    profile: null,
    pixFmt: 'yuv420p',
    width: null,
    height: null,
    channels: null,
    language: null,
    title: null,
    isDefault: false,
    isForced: false,
    isAttachedPicture: false,
    colorTransfer: null,
    bitDepth: null,
    ...partial,
  };
}

function probe(formatName: string, streams: ProbeStream[]): ProbeResult {
  return { formatName, duration: 100, bitRate: null, size: null, streams };
}

const options = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  extension: 'mkv',
  audioTrack: null,
  preferredAudioLanguage: '',
  forceTranscode: false,
  canEncodeH264: true,
  canEncodeVp9: true,
  ...overrides,
});

describe('planPlayback', () => {
  const h264Aac = probe('mov,mp4,m4a,3gp,3g2,mj2', [
    stream({ index: 0, type: 'video', codec: 'h264', profile: 'High' }),
    stream({ index: 1, type: 'audio', codec: 'aac', channels: 2 }),
  ]);

  it('lit directement un MP4 H.264/AAC', () => {
    expect(planPlayback(h264Aac, CHROME, options({ extension: 'mp4' })).mode).toBe('direct');
  });

  it('remultiplexe un MKV dont l’audio (AC3) est incompatible', () => {
    const plan = planPlayback(
      probe('matroska,webm', [
        stream({ index: 0, type: 'video', codec: 'h264' }),
        stream({ index: 1, type: 'audio', codec: 'ac3', channels: 6 }),
      ]),
      CHROME,
      options(),
    );
    expect(plan.mode).toBe('remux');
    expect(plan.output).toEqual({ video: 'copy', audio: 'aac' });
  });

  it('choisit la piste audio de la langue préférée', () => {
    const plan = planPlayback(
      probe('matroska,webm', [
        stream({ index: 0, type: 'video', codec: 'h264' }),
        stream({ index: 1, type: 'audio', codec: 'aac', language: 'en', isDefault: true }),
        stream({ index: 2, type: 'audio', codec: 'aac', language: 'fr' }),
      ]),
      CHROME,
      options({ preferredAudioLanguage: 'fr' }),
    );
    expect(plan.audioTrack).toBe(1);
    expect(plan.audioStream?.index).toBe(2);
    expect(plan.mode).toBe('remux');
    expect(plan.output?.audio).toBe('copy');
  });

  it('transcode le HEVC 10 bits et le H.264 10 bits', () => {
    const hevc = planPlayback(
      probe('matroska,webm', [
        stream({
          index: 0,
          type: 'video',
          codec: 'hevc',
          bitDepth: 10,
          colorTransfer: 'smpte2084',
        }),
        stream({ index: 1, type: 'audio', codec: 'eac3', channels: 6 }),
      ]),
      CHROME,
      options(),
    );
    expect(hevc.mode).toBe('transcode');
    expect(hevc.hdr).toBe(true);
    expect(hevc.output).toEqual({ video: 'h264', audio: 'aac' });

    const hi10p = planPlayback(
      probe('matroska,webm', [
        stream({ index: 0, type: 'video', codec: 'h264', profile: 'High 10', bitDepth: 10 }),
      ]),
      CHROME,
      options(),
    );
    expect(hi10p.mode).toBe('transcode');
  });

  it('se rabat sur VP9/Opus pour un navigateur sans codecs propriétaires', () => {
    const plan = planPlayback(h264Aac, NO_PROPRIETARY, options({ extension: 'mp4' }));
    expect(plan.mode).toBe('transcode');
    expect(plan.output).toEqual({ video: 'vp9', audio: 'opus' });
  });

  it('ignore les pochettes intégrées (attached_pic)', () => {
    const plan = planPlayback(
      probe('matroska,webm', [
        stream({ index: 0, type: 'video', codec: 'mjpeg', isAttachedPicture: true }),
        stream({ index: 1, type: 'video', codec: 'vp9' }),
        stream({ index: 2, type: 'audio', codec: 'opus' }),
      ]),
      CHROME,
      options({ extension: 'webm' }),
    );
    expect(plan.videoStream?.index).toBe(1);
    expect(plan.mode).toBe('direct');
  });
});

describe('buildStreamArgs', () => {
  it('produit un MP4 fragmenté avec positionnement et mappage des pistes', () => {
    const plan = planPlayback(
      probe('matroska,webm', [
        stream({
          index: 0,
          type: 'video',
          codec: 'hevc',
          bitDepth: 10,
          colorTransfer: 'smpte2084',
        }),
        stream({ index: 1, type: 'audio', codec: 'eac3' }),
      ]),
      CHROME,
      options(),
    );
    const args = buildStreamArgs({
      input: 'https://example.test/film.mkv',
      isRemote: true,
      userAgent: 'UA',
      start: 42,
      plan,
      preset: 'balanced',
      maxHeight: 1080,
      canTonemap: true,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-ss 42.000 -i https://example.test/film.mkv');
    expect(joined).toContain('-map 0:0 -map 0:1');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('tonemap=tonemap=hable');
    expect(joined).toContain("scale=-2:'min(1080,ih)'");
    expect(joined).toContain('-af aresample=async=1 -c:a aac -ac 2');
    expect(joined).toContain(
      '-movflags frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets pipe:1',
    );
    expect(args).toContain('-user_agent');
    expect(args).toContain('-reconnect_on_http_error');
    // Vidéo réencodée : positionnement à l'image près, pas de seconde sortie.
    expect(args).not.toContain('-noaccurate_seek');
    expect(args).not.toContain('framecrc');
  });

  it('en recopie vidéo, fait repartir l’audio de l’image clé et en signale l’instant', () => {
    const plan = planPlayback(
      probe('matroska,webm', [
        stream({ index: 0, type: 'video', codec: 'h264', profile: 'High' }),
        stream({ index: 1, type: 'audio', codec: 'ac3', channels: 6 }),
      ]),
      CHROME,
      options(),
    );
    expect(plan.mode).toBe('remux');
    const args = buildStreamArgs({
      input: '/films/film.mkv',
      isRemote: false,
      userAgent: 'UA',
      start: 37,
      plan,
      preset: 'balanced',
      maxHeight: 1080,
      canTonemap: false,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-ss 37.000 -noaccurate_seek -i /films/film.mkv');
    expect(joined).toContain('-c:v copy');
    expect(joined).toContain('pipe:1 -map 0:0 -c copy -frames:v 1 -f framecrc pipe:2');
    expect(args).not.toContain('-user_agent');
  });
});

describe('StreamOriginReader', () => {
  const framecrc = [
    '#extradata 0:       45, 0x2a120e36',
    '#software: Lavf60.16.100',
    '#tb 0: 1/1000',
    '#media_type 0: video',
    '#codec_id 0: h264',
    '0,      -7078,      -6995,       41,    11245, 0x9dc2f744',
    '',
  ].join('\n');

  it('déduit le départ réel du premier paquet vidéo, même reçu par morceaux', () => {
    const origins: number[] = [];
    const reader = new StreamOriginReader(37, (origin) => origins.push(origin));
    for (let index = 0; index < framecrc.length; index += 7) {
      reader.push(framecrc.slice(index, index + 7));
    }
    expect(origins).toHaveLength(1);
    expect(origins[0]).toBeCloseTo(30.005, 3);
    expect(reader.lastError).toBeNull();
  });

  it('tient compte de la base de temps et garde le journal d’erreurs', () => {
    const origins: number[] = [];
    const reader = new StreamOriginReader(100, (origin) => origins.push(origin));
    reader.push('[http @ 0x1] HTTP error 502 Bad Gateway\n#tb 0: 1/90000\n');
    reader.push('0,    -450000,    -450000,     3754,    40000, 0x00000001\n');
    reader.push('0,    -446246,    -442492,     3754,    10000, 0x00000002\n');
    expect(origins).toEqual([95]);
    expect(reader.lastError).toBe('[http @ 0x1] HTTP error 502 Bad Gateway');
  });
});

describe('sous-titres', () => {
  it('convertit un SRT en WebVTT', () => {
    const vtt = srtToVtt(
      '1\r\n00:00:01,500 --> 0:00:03,000\r\n{\\an8}<font color="red">Bonjour</font>\r\n',
    );
    expect(vtt).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nBonjour\n');
  });

  it('décode un fichier Windows-1252', () => {
    expect(decodeText(Buffer.from('Déjà vu à Noël', 'latin1'))).toBe('Déjà vu à Noël');
    expect(decodeText(Buffer.from('\uFEFFDéjà vu', 'utf8'))).toBe('Déjà vu');
  });
});
