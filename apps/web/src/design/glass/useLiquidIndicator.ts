import { useLayoutEffect, useRef } from 'react';

/**
 * Indicateur de sélection « liquide » : une goutte de verre glisse vers l'élément actif.
 * Son bord avant part plus vite que son bord arrière, si bien qu'elle s'étire puis se
 * rétracte comme un liquide (HIG : le verre se transforme d'un état à l'autre).
 *
 * Renvoie deux références : le conteneur (positionné) et l'indicateur. Les éléments
 * candidats portent `data-indicator-key` ; la position est écrite directement dans le style
 * de l'indicateur (aucun rendu React supplémentaire).
 */
export function useLiquidIndicator<
  Container extends HTMLElement = HTMLDivElement,
  Indicator extends HTMLElement = HTMLSpanElement,
>(activeKey: string | number | null | undefined, axis: 'x' | 'y' = 'x') {
  const container = useRef<Container>(null);
  const indicator = useRef<Indicator>(null);

  useLayoutEffect(() => {
    const root = container.current;
    const pill = indicator.current;
    if (!root || !pill) return;

    const measure = () => {
      const target =
        activeKey === null || activeKey === undefined
          ? null
          : root.querySelector<HTMLElement>(
              `[data-indicator-key="${CSS.escape(String(activeKey))}"]`,
            );
      if (!target || target.offsetWidth === 0) {
        pill.style.opacity = '0';
        return;
      }
      const start = axis === 'x' ? target.offsetLeft : target.offsetTop;
      const size = axis === 'x' ? target.offsetWidth : target.offsetHeight;
      const total = axis === 'x' ? root.scrollWidth : root.scrollHeight;
      const cross = axis === 'x' ? target.offsetTop : target.offsetLeft;
      const crossSize = axis === 'x' ? target.offsetHeight : target.offsetWidth;

      // Position précédente conservée sur l'élément : elle survit aux changements d'onglet.
      const previousStart = pill.dataset.start ? Number(pill.dataset.start) : null;
      pill.dataset.direction =
        previousStart === null || previousStart === start
          ? 'none'
          : start > previousStart
            ? 'forward'
            : 'backward';
      pill.dataset.axis = axis;
      pill.style.setProperty('--ind-start', `${start}px`);
      pill.style.setProperty('--ind-end', `${total - start - size}px`);
      pill.style.setProperty('--ind-cross', `${cross}px`);
      pill.style.setProperty('--ind-cross-size', `${crossSize}px`);
      pill.style.opacity = '1';
      if (previousStart === null) {
        // Première mesure : placement immédiat, les transitions s'activent ensuite.
        requestAnimationFrame(() => {
          pill.dataset.ready = 'true';
        });
      }
      pill.dataset.start = String(start);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [activeKey, axis]);

  return { container, indicator };
}
