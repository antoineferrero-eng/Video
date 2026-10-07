import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * - primary : verre proéminent teinté à la couleur d'accent (action principale uniquement) ;
 * - glass / glass-clear : Liquid Glass (commandes flottantes ; « clear » sur images et vidéos) ;
 * - secondary : remplissage translucide de la couche de contenu ;
 * - ghost : texte seul ; danger : action destructrice.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass' | 'glass-clear';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg' | 'icon-xl';

const PRESS = 'transition duration-150 active:scale-[0.97]';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'glass glass-prominent glass-interactive font-semibold text-ink-950',
  secondary: cn('fill text-zinc-100 hover:bg-white/[0.12]', PRESS),
  ghost: cn('text-zinc-300 hover:bg-white/[0.08] hover:text-white', PRESS),
  danger: cn(
    'bg-red-500/15 text-red-200 shadow-[inset_0_0_0_1px_rgb(248_113_113/0.3)] hover:bg-red-500/25',
    PRESS,
  ),
  glass: 'glass glass-interactive text-white',
  'glass-clear': 'glass glass-clear glass-interactive text-white',
};

/** Formes iOS 26 : capsules et cercles pour toutes les commandes tactiles. */
const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 rounded-full px-3.5 text-xs',
  md: 'h-10 gap-2 rounded-full px-[1.125rem] text-sm',
  lg: 'h-12 gap-2.5 rounded-full px-6 text-[15px]',
  icon: 'size-10 rounded-full',
  'icon-sm': 'size-8 rounded-full',
  'icon-lg': 'size-12 rounded-full',
  'icon-xl': 'size-16 rounded-full',
};

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function isGlassVariant(variant: ButtonVariant | undefined): boolean {
  return variant === 'glass' || variant === 'glass-clear';
}

export function buttonClasses(
  { variant = 'secondary', size = 'md' }: ButtonStyleProps,
  className?: string,
): string {
  return cn(
    'relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-45',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
