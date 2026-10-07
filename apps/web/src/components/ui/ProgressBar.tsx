import { cn } from '../../lib/cn';

type Tone = 'brand' | 'success' | 'muted' | 'danger' | 'white';

const TONES: Record<Tone, string> = {
  brand: 'bg-gradient-to-r from-brand-400 to-brand-500',
  success: 'bg-emerald-400',
  muted: 'bg-zinc-500',
  danger: 'bg-red-400',
  white: 'bg-white',
};

export function ProgressBar({
  value,
  tone = 'brand',
  className,
  indeterminate = false,
}: {
  value: number | null;
  tone?: Tone;
  className?: string;
  indeterminate?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, (value ?? 0) * 100));
  return (
    <div
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-white/10', className)}
      role="progressbar"
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
            'h-full rounded-full transition-[width] duration-500 ease-out',
            TONES[tone],
          )}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
