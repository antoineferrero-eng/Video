import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientCapabilities } from '@lumiere/shared';
import { parseProbe } from '../src/modules/playback/ffmpeg';
import { buildStreamArgs } from '../src/modules/playback/ffmpeg-args';
import { planPlayback, type PlaybackPlan } from '../src/modules/playback/planner';
import { StreamOriginReader } from '../src/modules/playback/stream-origin';

/**
 * Synchronisation audio / vidéo du flux converti (ffmpeg réel) quand une piste commence après
 * l'autre dans le fichier (VF d'une autre source recalée par un retard, vidéo qui démarre
 * après le son). Le navigateur referme les trous de l'audio : on vérifie donc que l'audio
 * produit est continu, et qu'un bip y tombe au même instant de l'image que dans la source.
 */
const hasFfmpeg =
  spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 &&
  spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;

const CHROME: ClientCapabilities = {
  videoCodecs: ['h264', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
  containers: ['mp4', 'webm'],
};

let dir: string;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr?.toString()).toBe(0);
  return result;
}

/** Film de 12 s (images clés toutes les 2 s), bip toutes les 2 s dans l'audio (à 1,9 s, 3,9 s…). */
function makeSource(name: string, delays: { video?: number; audio?: number }): string {
  const file = path.join(dir, name);
  run('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-itsoffset', String(delays.video ?? 0)],
    ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=12'],
    ...['-itsoffset', String(delays.audio ?? 0)],
    ...[
      '-f',
      'lavfi',
      '-i',
      "sine=frequency=1000:sample_rate=48000:duration=12,volume=enable='lt(mod(t,2),1.9)':volume=0",
    ],
    ...['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2'],
    ...['-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-b:a', '96k', file],
  ]);
  return file;
}

function plan(file: string): PlaybackPlan {
  const probe = run('ffprobe', [
    ...['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
  ]);
  return planPlayback(parseProbe(JSON.parse(probe.stdout.toString())), CHROME, {
    extension: 'mkv',
    audioTrack: null,
    preferredAudioLanguage: '',
    forceTranscode: false,
    canEncodeH264: true,
    canEncodeVp9: true,
  });
}

/** Flux tel que le produit l'application, et l'instant de la source où il démarre. */
function stream(file: string, start: number, playback: PlaybackPlan) {
  const args = buildStreamArgs({
    input: file,
    isRemote: false,
    userAgent: 'UA',
    start,
    plan: playback,
    preset: 'fast',
    maxHeight: 1080,
    canTonemap: false,
  });
  const result = run('ffmpeg', args);
  const output = path.join(dir, `out-${path.basename(file)}-${start}.mp4`);
  fs.writeFileSync(output, result.stdout);
  let origin: number | null = null;
  new StreamOriginReader(start, (value) => (origin = value)).push(`${result.stderr.toString()}\n`);
  return { output, origin: origin ?? start };
}

function packets(file: string, stream: 'v' | 'a', keyframesOnly = false): number[] {
  const result = run('ffprobe', [
    ...['-v', 'error', '-select_streams', `${stream}:0`],
    ...['-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
  ]);
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.split(','))
    .filter(([, flags = '']) => !keyframesOnly || flags.startsWith('K'))
    .map(([pts = '']) => Number(pts))
    .filter(Number.isFinite);
}

function startTime(file: string): number {
  const value = run('ffprobe', [
    ...['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file],
  ]);
  const parsed = Number(value.stdout.toString().trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Début des bips, en horodatage du fichier. */
function beeps(file: string): number[] {
  const result = run('ffmpeg', [
    ...['-hide_banner', '-nostats', '-i', file, '-map', '0:a'],
    ...['-af', 'silencedetect=n=-30dB:d=0.05', '-f', 'null', '-'],
  ]);
  const start = startTime(file);
  return [...result.stderr.toString().matchAll(/silence_end: ([\d.]+)/g)].map(
    (match) => Number(match[1]) + start,
  );
}

const nearest = (values: number[], target: number) =>
  values.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best,
  );

/**
 * Lit le flux comme le navigateur : chaque image à son horodatage, l'audio joué d'un bloc
 * à partir de son premier paquet (les trous sont refermés). Mesure, pour un bip de la
 * source, l'écart entre le son et l'image correspondante, et l'écart entre l'image et
 * l'horloge du lecteur (origine annoncée + temps du flux), sur laquelle les sous-titres
 * sont calés.
 */
function measure(source: string, start: number) {
  const playback = plan(source);
  expect(playback.mode).toBe('remux');
  const { output, origin } = stream(source, start, playback);
  const sourceStart = startTime(source);

  // La i-ème image affichée du flux est la i-ème de la source à partir de l'image clé
  // atteinte (affichée un peu après l'origine, instant de décodage, si images B).
  const sourceFrames = packets(source, 'v').sort((a, b) => a - b);
  const outputFrames = packets(output, 'v').sort((a, b) => a - b);
  const keyframe = Math.min(
    ...packets(source, 'v', true).filter((pts) => pts >= sourceStart + origin - 0.001),
  );
  const first = sourceFrames.indexOf(keyframe);
  const shownAt = (sourceTime: number) => {
    const index = sourceFrames.indexOf(nearest(sourceFrames.slice(first), sourceTime)) - first;
    return outputFrames[index]! + (sourceTime - sourceFrames[index + first]!);
  };

  // Bip du flux, et le même dans la source (d'après l'image à laquelle il est décodé).
  const audio = packets(output, 'a');
  const frame = audio[audio.length - 1]! - audio[audio.length - 2]!;
  const decoded = beeps(output).find((time) => time > audio[0]! + 0.3)!;
  const outputIndex = outputFrames.indexOf(nearest(outputFrames, decoded));
  const beep = nearest(beeps(source), sourceFrames[first + outputIndex]!);
  // Instant où le navigateur le joue : les paquets s'enchaînent sans trou.
  const packet = audio.findLastIndex((pts) => pts <= decoded + 0.0001);
  const heard = audio[0]! + packet * frame + (decoded - audio[packet]!);

  const video = shownAt(beep);
  return {
    playback,
    /** Son en avance (négatif) ou en retard sur l'image, en secondes. */
    audioLag: heard - video,
    /** Horloge du lecteur moins l'instant de l'image affichée (sous-titres en avance si > 0). */
    clockError: origin + video - (beep - sourceStart),
  };
}

function expectInSync(source: string, start: number) {
  const result = measure(source, start);
  expect(Math.abs(result.audioLag), `son décalé de ${result.audioLag.toFixed(3)} s`).toBeLessThan(
    0.03,
  );
  expect(
    Math.abs(result.clockError),
    `horloge décalée de ${result.clockError.toFixed(3)} s`,
  ).toBeLessThan(0.05);
  return result.playback;
}

describe.skipIf(!hasFfmpeg)('synchronisation audio / vidéo du flux converti', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-sync-'));
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('garde le retard d’une piste audio qui commence après l’image', () => {
    const source = makeSource('vf-retardee.mkv', { audio: 1 });
    const playback = expectInSync(source, 0);
    // Recopiée, la piste garderait un trou au début : elle est convertie.
    expect(playback.output?.audio).toBe('aac');
    // Retard d'1 s moins le préambule de l'encodeur AAC (21 ms).
    expect(playback.reasons.join(' ')).toMatch(/Audio décalé de (0\.9[78]|1\.00) s/);
  });

  it('cale le temps du lecteur sur une vidéo qui commence après le son', () => {
    const source = makeSource('video-retardee.mkv', { video: 0.5 });
    const playback = expectInSync(source, 0);
    expect(playback.videoStart).toBeGreaterThan(0.45);
  });

  it('reste synchronisé après un positionnement', () => {
    expectInSync(makeSource('vf-retardee-2.mkv', { audio: 1 }), 5);
  });

  it('recopie l’audio quand les pistes démarrent ensemble', () => {
    const playback = expectInSync(makeSource('aligne.mkv', {}), 0);
    expect(playback.output?.audio).toBe('copy');
  });
});
