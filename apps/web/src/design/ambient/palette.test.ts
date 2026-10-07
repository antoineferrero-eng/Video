import { describe, expect, it } from 'vitest';
import { activeNavKey } from '../../components/layout/navigation';
import { paletteFromPixels, paletteFromSeed } from './palette';

function pixels(...colors: Array<[number, number, number, number]>): number[] {
  // Chaque entrée : [r, g, b, nombre de pixels].
  return colors.flatMap(([r, g, b, count]) =>
    Array.from({ length: count }, () => [r, g, b, 255]).flat(),
  );
}

const hue = (color: string) => Number(/hsl\((\d+)/.exec(color)?.[1]);

describe("palette d'ambiance", () => {
  it('extrait les teintes dominantes, la plus présente en premier', () => {
    const palette = paletteFromPixels(
      pixels([220, 40, 40, 300], [40, 90, 220, 200], [40, 200, 90, 100]),
    );
    expect(palette).not.toBeNull();
    const [first, second, third] = (palette ?? []).map(hue);
    expect(first).toBeLessThan(15);
    expect(second).toBeGreaterThan(200);
    expect(second).toBeLessThan(240);
    expect(third).toBeGreaterThan(120);
    expect(third).toBeLessThan(160);
  });

  it('assombrit les couleurs pour en faire une lumière d’ambiance', () => {
    const [color] = paletteFromPixels(pixels([255, 230, 60, 400])) ?? [];
    const lightness = Number(/(\d+)%\)$/.exec(color ?? '')?.[1]);
    expect(lightness).toBeLessThanOrEqual(50);
  });

  it('ignore les images ternes (gris, noir)', () => {
    expect(paletteFromPixels(pixels([128, 128, 128, 500], [5, 5, 5, 500]))).toBeNull();
  });

  it('dérive une palette stable d’un titre sans illustration', () => {
    expect(paletteFromSeed('Les Explorateurs')).toEqual(paletteFromSeed('Les Explorateurs'));
    expect(paletteFromSeed('Orbite')).not.toEqual(paletteFromSeed('Les Explorateurs'));
  });
});

describe('navigation', () => {
  it('associe chaque URL à son entrée (ou à aucune pour une fiche)', () => {
    expect(activeNavKey('/')).toBe('/');
    expect(activeNavKey('/films')).toBe('/films');
    expect(activeNavKey('/telechargements')).toBe('/telechargements');
    expect(activeNavKey('/titre/12')).toBeNull();
    expect(activeNavKey('/filmsx')).toBeNull();
  });
});
