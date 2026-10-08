import { describe, expect, it } from 'vitest';
import type { Cue } from '../../lib/vtt';
import { NO_SYNC, anchorCue, describeSync, subtitleTime, syncFromAnchors } from './subtitle-sync';

const cue = (start: number, end: number): Cue => ({ start, end, html: '' });
const cues = [cue(10, 12), cue(20, 23), cue(30, 31)];

describe('recalage manuel des sous-titres', () => {
  it('trouve la réplique à caler : la suivante, ou la dernière affichée', () => {
    expect(anchorCue(cues, 15, NO_SYNC, 'next')?.start).toBe(20);
    expect(anchorCue(cues, 21, NO_SYNC, 'previous')?.start).toBe(20);
    // Déjà recalés de +5 s : à 24 s de vidéo, on en est à 19 s du fichier.
    expect(anchorCue(cues, 24, { offset: 5, rate: 1 }, 'next')?.start).toBe(20);
    expect(anchorCue(cues, 5, NO_SYNC, 'previous')).toBeNull();
  });

  it('déduit le décalage d’une réplique calée, la vitesse de deux répliques éloignées', () => {
    // Réplique prévue à 20 s, entendue à 22,5 s : décalage de +2,5 s.
    expect(syncFromAnchors([{ cue: 20, media: 22.5 }], NO_SYNC)).toEqual({ offset: 2.5, rate: 1 });
    // Sous-titres d'une version à 25 i/s : 4 % trop tôt, mesuré à 10 min puis à 60 min.
    const ratio = 25 / 23.976;
    const sync = syncFromAnchors(
      [
        { cue: 600 / ratio, media: 600 },
        { cue: 3600 / ratio, media: 3600 },
      ],
      NO_SYNC,
    );
    expect(sync.rate).toBeCloseTo(ratio, 9);
    expect(subtitleTime(1800, sync)).toBeCloseTo(1800 / ratio, 2);
    // Deux répliques trop proches : décalage seulement.
    expect(
      syncFromAnchors(
        [
          { cue: 100, media: 101 },
          { cue: 130, media: 131.5 },
        ],
        NO_SYNC,
      ),
    ).toEqual({ offset: 1.5, rate: 1 });
  });

  it('résume un recalage', () => {
    expect(describeSync({ offset: 1.25, rate: 1 })).toBe('+1,25 s');
    expect(describeSync({ offset: -0.4, rate: 25 / 23.976 })).toBe('−0,40 s · vitesse ×1,043');
  });
});
