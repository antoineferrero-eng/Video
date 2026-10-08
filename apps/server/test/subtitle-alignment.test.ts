import { describe, expect, it } from 'vitest';
import {
  align,
  cueActivity,
  isReliable,
  parseCueTimes,
  speechActivity,
  type Interval,
  type ReferenceWindow,
} from '../src/modules/playback/subtitle-alignment';

/** Générateur pseudo-aléatoire reproductible. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Répliques d'un film : 1 à 4 s, séparées de 0,5 à 6 s. */
function dialogue(duration: number, seed = 1): Interval[] {
  const next = random(seed);
  const cues: Interval[] = [];
  let time = 20;
  while (time < duration - 10) {
    const length = 1 + next() * 3;
    cues.push([time, time + length]);
    time += length + 0.5 + next() * 5.5;
  }
  return cues;
}

const transform = (cues: Interval[], rate: number, offset: number): Interval[] =>
  cues.map(([start, end]): Interval => [start * rate + offset, end * rate + offset]);

/** Référence = la piste bien calée, sur toute la durée (comme une piste intégrée). */
function subtitleReference(cues: Interval[], duration: number): ReferenceWindow[] {
  return [{ start: 0, step: 0.01, values: cueActivity(cues, duration, 0.01) }];
}

/**
 * Audio simulé : voix (bruit modulé au rythme des syllabes) pendant les répliques, sur une
 * ambiance (bruit et note tenue) dont le volume varie lentement.
 */
function audio(cues: Interval[], from: number, length: number, background = 700): Int16Array {
  const rate = 8000;
  const next = random(7);
  const samples = new Int16Array(Math.round(length * rate));
  let cue = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const time = from + index / rate;
    while (cue < cues.length && cues[cue]![1] <= time) cue += 1;
    const speaking = cue < cues.length && cues[cue]![0] <= time;
    const syllables = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 2 * time));
    const ambience =
      (next() * 2 - 1) * background * (0.5 + 0.5 * Math.sin(time / 3)) +
      background * 0.8 * Math.sin(2 * Math.PI * 440 * time) * (0.5 + 0.5 * Math.sin(time / 7));
    const voice = speaking ? (next() * 2 - 1) * 9000 * syllables : 0;
    samples[index] = Math.max(-32767, Math.min(32767, Math.round(ambience + voice)));
  }
  return samples;
}

const excerpts = (cues: Interval[], background: number) =>
  [900, 2700, 4500, 6300].map((start): ReferenceWindow => ({
    start,
    step: 0.01,
    values: speechActivity(audio(cues, start, 45, background), 8000),
  }));

describe('recalage automatique des sous-titres', () => {
  const duration = 2 * 3600;
  const truth = dialogue(duration);

  it('lit les horodatages d’un WebVTT', () => {
    expect(
      parseCueTimes(
        'WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nBonjour\n\n02:04.250 --> 02:05.000\nSalut\n',
      ),
    ).toEqual([
      [1.5, 3],
      [124.25, 125],
    ]);
  });

  it('retrouve un décalage constant sur une piste de référence', () => {
    const late = transform(truth, 1, 3.21);
    const result = align(subtitleReference(truth, duration), late);
    expect(result?.rate).toBe(1);
    expect(result?.offset).toBeCloseTo(-3.21, 1);
    expect(isReliable(result)).toBe(true);
    expect(result!.score).toBeGreaterThan(result!.baseline);
  });

  it('retrouve des sous-titres faits pour 25 i/s sur une vidéo à 23,976 i/s', () => {
    // Version PAL : 4 % plus rapide, répliques plus tôt d'autant, plus un logo de 1,5 s.
    const pal = transform(truth, 23.976 / 25, 1.5);
    const result = align(subtitleReference(truth, duration), pal);
    expect(result?.rate).toBeCloseTo(25 / 23.976, 6);
    const shown = transform(pal, result!.rate, result!.offset);
    // Chaque réplique retombe à moins d'un dixième de seconde de sa place.
    const worst = Math.max(...shown.map(([start], index) => Math.abs(start - truth[index]![0])));
    expect(worst).toBeLessThan(0.1);
  });

  it('se cale sur la parole détectée dans quelques extraits de l’audio', () => {
    const early = transform(truth, 1, -7.4);
    for (const background of [700, 3000, 6000]) {
      const result = align(excerpts(truth, background), early);
      expect(result?.rate).toBe(1);
      expect(result?.offset).toBeCloseTo(7.4, 1);
      expect(isReliable(result), `ambiance ${background}`).toBe(true);
    }
  });

  it('ne trouve rien de fiable dans des sous-titres sans rapport', () => {
    for (const seed of [99, 5, 42]) {
      const unrelated = dialogue(duration, seed);
      expect(isReliable(align(subtitleReference(truth, duration), unrelated))).toBe(false);
      expect(isReliable(align(excerpts(truth, 3000), unrelated))).toBe(false);
    }
  });
});
