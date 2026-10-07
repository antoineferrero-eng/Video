import { cn } from '../../lib/cn';

type Tone = 'brand' | 'success' | 'muted' | 'danger' | 'white';

const TONES: Record<Tone, string> = {
  brand: 'bg-gradient-to-r from-brand-300 to-brand-500',
  success: 'bg-gradient-to-r from-emerald-300 to-emerald-500',
  muted: 'bg-zinc-500',
  danger: 'bg-red-400',
  white: 'bg-white',
};

export function ProgressBar({
  value,
  tone = 'brand',
  className,
  indeterminate = false,
  label = 'Progression',
}: {
  value: number | null;
  tone?: Tone;
  className?: string;
  indeterminate?: boolean;
  label?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value ?? 0) * 100));
  return (
    <div
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.12] shadow-[inset_0_1px_1px_rgb(0_0_0/0.35)]',
        className,
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      {indeterminate ? (
        <div
          className={cn(
            'absolute inset-y-0 w-1/3 animate-[shimmer_1.4s_linear_infinite] rounded-full',
            TONES[tone],
          )}
        />
      ) : (
        <div
          className={cn(
            'h-full rounded-full shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] transition-[width] duration-500 ease-out',
            TONES[tone],
          )}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
