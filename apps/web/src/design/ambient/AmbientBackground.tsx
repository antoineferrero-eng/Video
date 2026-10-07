import type { CSSProperties } from 'react';
import { useAmbientPalette } from './ambient';

/** Fond d'ambiance de l'application : lumières colorées sur lesquelles le verre se détache. */
export function AmbientBackground() {
  const [a, b, c] = useAmbientPalette();
  return (
    <div
      aria-hidden="true"
      className="ambient"
      style={{ '--ambient-a': a, '--ambient-b': b, '--ambient-c': c } as CSSProperties}
    />
  );
}
