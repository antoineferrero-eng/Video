import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAppearance, detectRefractionSupport, type SystemPreferences } from './appearance';
import { lensDisplacement } from './refraction';

const NO_PREFERENCE: SystemPreferences = {
  reducedTransparency: false,
  moreContrast: false,
  reducedMotion: false,
};
const DEFAULTS = { material: 'clear' as const, refraction: true, dynamicLight: true };

describe('apparence effective', () => {
  it('active le verre transparent, la réfraction et les reflets par défaut', () => {
    expect(computeAppearance(DEFAULTS, NO_PREFERENCE, true)).toMatchObject({
      material: 'clear',
      refractionActive: true,
      lightActive: true,
    });
  });

  it('« Réduire la transparence » rend le verre opaque, sans réfraction ni reflets', () => {
    const state = computeAppearance(
      DEFAULTS,
      { ...NO_PREFERENCE, reducedTransparency: true },
      true,
    );
    expect(state).toMatchObject({ material: 'solid', refractionActive: false, lightActive: false });
  });

  it('le contraste élevé coupe la réfraction, les mouvements réduits coupent les reflets', () => {
    expect(
      computeAppearance(DEFAULTS, { ...NO_PREFERENCE, moreContrast: true }, true).refractionActive,
    ).toBe(false);
    expect(
      computeAppearance(DEFAULTS, { ...NO_PREFERENCE, reducedMotion: true }, true).lightActive,
    ).toBe(false);
  });

  it('le garde-fou de fluidité coupe la réfraction pour la session', () => {
    const throttled = computeAppearance(DEFAULTS, NO_PREFERENCE, true, {
      refractionThrottled: true,
      frameGuard: false,
    });
    expect(throttled).toMatchObject({
      refractionActive: false,
      material: 'clear',
      lightActive: true,
    });
  });

  it('respecte les préférences et la prise en charge du navigateur', () => {
    expect(computeAppearance(DEFAULTS, NO_PREFERENCE, false).refractionActive).toBe(false);
    expect(
      computeAppearance({ ...DEFAULTS, refraction: false }, NO_PREFERENCE, true).refractionActive,
    ).toBe(false);
    expect(
      computeAppearance({ ...DEFAULTS, material: 'tinted' }, NO_PREFERENCE, true),
    ).toMatchObject({ material: 'tinted', refractionActive: true });
  });
});

describe('détection de la réfraction', () => {
  afterEach(() => vi.unstubAllGlobals());

  const browser = (userAgent: string, brands?: string[]) => {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('navigator', {
      userAgent,
      userAgentData: brands ? { brands: brands.map((brand) => ({ brand })) } : undefined,
    });
  };

  it('reconnaît les navigateurs Chromium', () => {
    browser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    );
    expect(detectRefractionSupport()).toBe(true);
    browser('Mozilla/5.0', ['Chromium', 'Google Chrome', 'Not=A?Brand']);
    expect(detectRefractionSupport()).toBe(true);
  });

  it('exclut Safari, Firefox et les navigateurs iOS (WebKit)', () => {
    browser(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    );
    expect(detectRefractionSupport()).toBe(false);
    browser('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0');
    expect(detectRefractionSupport()).toBe(false);
    browser(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
    );
    expect(detectRefractionSupport()).toBe(false);
  });

  it('exige backdrop-filter avec url()', () => {
    browser('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36');
    vi.stubGlobal('CSS', { supports: () => false });
    expect(detectRefractionSupport()).toBe(false);
  });
});

describe('carte de réfraction', () => {
  const capsule = { width: 200, height: 60, radius: 30, bezel: 16 };

  it('ne déplace rien au centre ni hors du biseau', () => {
    expect(lensDisplacement(0, 0, capsule)).toEqual([0, 0]);
    expect(lensDisplacement(0, -10, capsule)).toEqual([0, 0]);
    expect(lensDisplacement(150, 0, capsule)).toEqual([0, 0]);
  });

  it('oriente le déplacement vers l’intérieur, plus fort près du bord', () => {
    const [topX, topY] = lensDisplacement(0, -29, capsule);
    expect(topX).toBe(0);
    expect(topY).toBeGreaterThan(0.5);
    const [, bottomY] = lensDisplacement(0, 29, capsule);
    expect(bottomY).toBeLessThan(-0.5);
    const [, nearEdge] = lensDisplacement(0, -29, capsule);
    const [, deeper] = lensDisplacement(0, -20, capsule);
    expect(nearEdge).toBeGreaterThan(deeper);
  });

  it('suit la courbure des coins (diagonale vers le centre)', () => {
    const panel = { width: 200, height: 200, radius: 40, bezel: 20 };
    const [dx, dy] = lensDisplacement(85, 85, panel);
    expect(dx).toBeLessThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.abs(dx - dy)).toBeLessThan(1e-9);
  });
});
