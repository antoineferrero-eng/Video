import { useEffect, type RefObject } from 'react';
import { useAppearance } from './appearance';
import { acquireLens, releaseLens } from './refraction';

export interface LensOptions {
  /** Largeur du biseau en px (défaut : proportionnelle à la plus petite dimension). */
  bezel?: number;
  /** Déplacement maximal au bord en px (défaut : proportionnel). */
  strength?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Applique la réfraction des bords à un élément en verre : la carte de déplacement suit la
 * taille et le rayon réels de l'élément (ResizeObserver). Sans effet si la réfraction est
 * désactivée (préférences, accessibilité) ou non prise en charge par le navigateur.
 */
export function useLens(ref: RefObject<HTMLElement | null>, options: LensOptions | false = {}) {
  const { refractionActive } = useAppearance();
  const enabled = options !== false && refractionActive;
  const bezel = options === false ? undefined : options.bezel;
  const strength = options === false ? undefined : options.strength;

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let filterId: string | null = null;
    let timer: number | undefined;

    const apply = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width < 16 || height < 16) return;
      const shortest = Math.min(width, height);
      const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      const next = acquireLens({
        width,
        height,
        radius,
        bezel: bezel ?? clamp(shortest * 0.32, 8, 24),
        strength: strength ?? clamp(shortest * 0.26, 6, 22),
      });
      element.style.setProperty('--lg-refraction', `url(#${next})`);
      if (filterId) releaseLens(filterId);
      filterId = next;
    };

    apply();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      // Pendant une animation de taille, on attend la forme finale avant de recalculer.
      timer = window.setTimeout(apply, 140);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      element.style.removeProperty('--lg-refraction');
      if (filterId) releaseLens(filterId);
    };
  }, [ref, enabled, bezel, strength]);
}
