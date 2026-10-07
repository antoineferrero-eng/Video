import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'violet';

/** Remplissages vibrants (couche de contenu) : jamais de verre pour une simple étiquette. */
const TONES: Record<Tone, string> = {
  neutral: 'bg-white/[0.08] text-zinc-200 ring-white/10',
  brand: 'bg-brand-400/15 text-brand-200 ring-brand-300/30',
  success: 'bg-emerald-400/15 text-emerald-200 ring-emerald-300/25',
  warning: 'bg-amber-400/15 text-amber-200 ring-amber-300/25',
  danger: 'bg-red-400/15 text-red-200 ring-red-300/25',
  info: 'bg-sky-400/15 text-sky-200 ring-sky-300/25',
  violet: 'bg-violet-400/15 text-violet-200 ring-violet-300/25',
};

export function Badge({
  tone = 'neutral',
  icon,
  className,
  children,
  title,
}: {
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
