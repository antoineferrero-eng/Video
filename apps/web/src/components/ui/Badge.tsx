import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'violet';

const TONES: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300 ring-white/10',
  brand: 'bg-brand-400/15 text-brand-300 ring-brand-400/30',
  success: 'bg-emerald-400/12 text-emerald-300 ring-emerald-400/25',
  warning: 'bg-amber-400/12 text-amber-300 ring-amber-400/25',
  danger: 'bg-red-400/12 text-red-300 ring-red-400/25',
  info: 'bg-sky-400/12 text-sky-300 ring-sky-400/25',
  violet: 'bg-violet-400/12 text-violet-300 ring-violet-400/25',
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
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
