import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_PALETTE, paletteFromImage, paletteFromSeed, type Palette } from './palette';

/**
 * Magasin de la palette d'ambiance courante. Une page « réclame » l'ambiance avec
 * `useAmbient` (illustration du titre affiché) ; en la quittant, l'ambiance revient à la
 * palette par défaut, sauf si la page suivante en fournit une entre-temps.
 */
const listeners = new Set<() => void>();
let palette: Palette = DEFAULT_PALETTE;
let owner = 0;
let resetTimer: number | undefined;

function setPalette(next: Palette): void {
  if (next.every((color, index) => color === palette[index])) return;
  palette = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAmbientPalette(): Palette {
  return useSyncExternalStore(
    subscribe,
    () => palette,
    () => palette,
  );
}

/** Colore l'ambiance avec une illustration (ou, à défaut, les teintes dérivées du titre). */
export function useAmbient(image: string | null | undefined, seed: string | null | undefined) {
  useEffect(() => {
    if (!image && !seed) return;
    owner += 1;
    const token = owner;
    window.clearTimeout(resetTimer);
    const fallback = seed ? paletteFromSeed(seed) : DEFAULT_PALETTE;
    if (!image) setPalette(fallback);
    else
      void paletteFromImage(image).then((extracted) => {
        if (owner === token) setPalette(extracted ?? fallback);
      });
    return () => {
      if (owner !== token) return;
      resetTimer = window.setTimeout(() => {
        if (owner === token) setPalette(DEFAULT_PALETTE);
      }, 250);
    };
  }, [image, seed]);
}
