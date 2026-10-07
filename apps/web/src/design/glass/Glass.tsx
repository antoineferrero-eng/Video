import { useCallback, useRef, type HTMLAttributes, type Ref } from 'react';
import { cn } from '../../lib/cn';
import { useLens, type LensOptions } from './useLens';

export type GlassVariant = 'regular' | 'clear' | 'thick';

const VARIANT_CLASSES: Record<GlassVariant, string> = {
  regular: 'glass',
  clear: 'glass glass-clear',
  thick: 'glass glass-thick',
};

export interface GlassProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'aside' | 'nav' | 'header' | 'section' | 'span' | 'footer';
  variant?: GlassVariant;
  /** Réfraction des bords (désactivable, ou réglage fin du biseau). */
  lens?: LensOptions | false;
  /** Réaction au survol et au toucher (lueur interne, soulèvement élastique). */
  interactive?: boolean;
  ref?: Ref<HTMLElement>;
}

/** Surface Liquid Glass de la couche fonctionnelle (barres, panneaux, groupes de commandes). */
export function Glass({
  as = 'div',
  variant = 'regular',
  lens,
  interactive = false,
  className,
  ref,
  ...props
}: GlassProps) {
  const local = useRef<HTMLElement | null>(null);
  useLens(local, lens);
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      local.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const Element = as as 'div';
  return (
    <Element
      ref={setRef}
      className={cn(VARIANT_CLASSES[variant], interactive && 'glass-interactive', className)}
      {...props}
    />
  );
}
