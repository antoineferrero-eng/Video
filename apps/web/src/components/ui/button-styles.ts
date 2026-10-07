import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-brand-300 to-brand-500 text-ink-950 shadow-lg shadow-brand-500/20 hover:from-brand-200 hover:to-brand-400 font-semibold',
  secondary: 'bg-white/[0.07] text-zinc-100 ring-1 ring-inset ring-white/10 hover:bg-white/[0.12]',
  ghost: 'text-zinc-300 hover:bg-white/[0.07] hover:text-white',
  danger: 'bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/25',
  glass:
    'bg-black/40 text-white ring-1 ring-inset ring-white/15 backdrop-blur-md hover:bg-black/60',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-xs',
  md: 'h-10 gap-2 rounded-xl px-4 text-sm',
  lg: 'h-12 gap-2.5 rounded-xl px-6 text-[15px]',
  icon: 'size-10 rounded-xl',
  'icon-sm': 'size-8 rounded-lg',
};

export interface ButtonStyleProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function buttonClasses(
  { variant = 'secondary', size = 'md' }: ButtonStyleProps,
  className?: string,
): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition duration-150 select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
