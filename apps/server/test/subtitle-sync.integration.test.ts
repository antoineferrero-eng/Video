import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger';
import { KeyValueCache, openDatabase, type Db } from '../src/infra/database/database';
import { Ffmpeg } from '../src/modules/playback/ffmpeg';
import type { PlaybackService } from '../src/modules/playback/playback.service';
import type { PlaybackSessionState, SubtitleSource } from '../src/modules/playback/sessions';
import { SubtitleSyncService } from '../src/modules/playback/subtitle-sync.service';

/**
 * Recalage automatique avec le vrai ffmpeg, sur un audio synthétique de 8 minutes : de la
 * « voix » (bruit modulé au rythme des syllabes) pendant chaque réplique, sur une ambiance.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const silent = createLogger({ level: 'silent', pretty: false });
const DURATION = 480;
const RATE = 8000;

type Cue = [number, number];

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function dialogue(seed: number): Cue[] {
  const next = random(seed);
  const cues: Cue[] = [];
  let time = 5;
  while (time < DURATION - 10) {
    const length = 1 + next() * 3;
    cues.push([time, time + length]);
    time += length + 0.5 + next() * 4;
  }
  return cues;
}

function timestamp(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

function vtt(cues: Cue[], shift = 0): string {
  return `WEBVTT\n\n${cues
    .map(([start, end]) => `${timestamp(start + shift)} --> ${timestamp(end + shift)}\nRéplique`)
    .join('\n\n')}\n`;
}

/** WAV mono 16 bits : voix pendant les répliques, ambiance (bruit et note tenue) partout. */
function writeWav(file: string, cues: Cue[]): void {
  const next = random(3);
  const samples = Buffer.alloc(DURATION * RATE * 2);
  let cue = 0;
  for (let index = 0; index < DURATION * RATE; index += 1) {
    const time = index / RATE;
    while (cue < cues.length && cues[cue]![1] <= time) cue += 1;
    const speaking = cue < cues.length && cues[cue]![0] <= time;
    const syllables = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 2 * time));
    const ambience =
      (next() * 2 - 1) * 2500 * (0.5 + 0.5 * Math.sin(time / 3)) +
      2000 * Math.sin(2 * Math.PI * 440 * time);
    const voice = speaking ? (next() * 2 - 1) * 9000 * syllables : 0;
    samples.writeInt16LE(
      Math.max(-32767, Math.min(32767, Math.round(ambience + voice))),
      index * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, samples]));
}

const truth = dialogue(1);
let dir: string;
let db: Db;
let wav: string;

function track(id: string, source: SubtitleSource['source']): SubtitleSource {
  return {
    id,
    label: id,
    language: 'en',
    codec: 'subrip',
    source,
    supported: true,
    isDefault: false,
    isForced: false,
  };
}

/** Service de lecture réduit à ce que le recalage utilise. */
function setup(texts: Record<string, string>, references: Record<string, string> = {}) {
  const session = {
    id: 'session',
    mediaKey: `test:${Math.random()}`,
    input: wav,
    isRemote: false,
    duration: DURATION,
    size: fs.statSync(wav).size,
    plan: {
      videoStream: null,
      audioStream: { index: 0, channels: 1 },
      audioStreams: [],
    },
    subtitles: [
      ...Object.keys(texts).map((id) => track(id, 'online')),
      ...Object.keys(references).map((id) => track(id, 'embedded')),
    ],
  } as unknown as PlaybackSessionState;
  const playback = {
    session: () => session,
    subtitleTrack: (_: string, id: string) => session.subtitles.find((item) => item.id === id),
    subtitles: (_: string, id: string) => Promise.resolve(texts[id] ?? references[id]!),
    subtitlesIfAvailable: (_: string, id: string) => Promise.resolve(references[id] ?? null),
  } as unknown as PlaybackService;
  const ffmpeg = new Ffmpeg('ffmpeg', 'ffprobe', silent);
  return {
    ffmpeg,
    service: new SubtitleSyncService(playback, ffmpeg, new KeyValueCache(db), 'UA', silent),
  };
}

describe.skipIf(!hasFfmpeg)('recalage automatique des sous-titres (ffmpeg)', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-subsync-'));
    db = openDatabase(path.join(dir, 'test.db'), silent);
    wav = path.join(dir, 'film.wav');
    writeWav(wav, truth);
  });

  afterAll(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recale sur la voix des sous-titres en retard, et garde le réglage', async () => {
    const { ffmpeg, service } = setup({ 'onl-late': vtt(truth, 2.5) });
    await ffmpeg.detect();
    const result = await service.auto('session', 'onl-late');
    expect(result.sync).toMatchObject({ rate: 1, source: 'auto', note: 'calés sur la voix' });
    expect(result.sync!.offset).toBeCloseTo(-2.5, 1);
    expect(result.message).toMatch(/avancés de 2,5 s/);
    expect(service.state('session', 'onl-late').sync).toEqual(result.sync);

    service.reset('session', 'onl-late');
    expect(service.state('session', 'onl-late')).toEqual({ sync: null, autoFailed: false });
  }, 60_000);

  it('préfère une piste intégrée déjà disponible comme référence', async () => {
    const { ffmpeg, service } = setup({ 'onl-early': vtt(truth, -4) }, { 'emb-2': vtt(truth) });
    await ffmpeg.detect();
    const result = await service.auto('session', 'onl-early');
    expect(result.sync?.offset).toBeCloseTo(4, 1);
    expect(result.sync?.note).toBe('calés sur la piste intégrée (anglais)');
  }, 60_000);

  it('n’applique rien quand les sous-titres ne correspondent pas', async () => {
    const { ffmpeg, service } = setup({ 'onl-other': vtt(dialogue(77)) });
    await ffmpeg.detect();
    const result = await service.auto('session', 'onl-other');
    expect(result.sync).toBeNull();
    expect(result.message).toMatch(/incertain/);
    expect(service.state('session', 'onl-other')).toEqual({ sync: null, autoFailed: true });
  }, 60_000);
});
