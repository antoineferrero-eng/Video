import { cn } from '../../lib/cn';

type Tone = 'brand' | 'success' | 'muted' | 'danger' | 'white';

const TONES: Record<Tone, string> = {
  brand: 'bg-gradient-to-r from-brand-300 via-brand-400 to-brand-500',
  success: 'bg-gradient-to-r from-emerald-300 to-emerald-500',
  muted: 'bg-zinc-500',
  danger: 'bg-red-400',
  white: 'bg-white',
};

/**
 * Barre de progression. La partie remplie est une couche pleine largeur découpée par
 * `clip-path` (bouts arrondis conservés) : animer une largeur avec un reflet en ombre
 * intérieure laissait des pixels clairs au bord sur les écrans à mise à l'échelle
 * fractionnaire (125 %, 150 %). Sans valeur (`indeterminate`), un segment traverse la piste.
 */
export function ProgressBar({
  value,
  tone = 'brand',
  className,
  indeterminate = false,
  active = false,
  label = 'Progression',
}: {
  value: number | null;
  tone?: Tone;
  className?: string;
  indeterminate?: boolean;
  /** Reflet qui parcourt la barre (transfert en cours). */
  active?: boolean;
  label?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value ?? 0) * 100));
  return (
    <div
      className={cn(
        'relative isolate h-1.5 w-full overflow-hidden rounded-full bg-white/[0.12]',
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
            'absolute inset-y-0 left-0 w-2/5 animate-progress-indeterminate rounded-full motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50',
            TONES[tone],
          )}
        />
      ) : (
        <div
          className={cn(
            'absolute inset-0 overflow-hidden rounded-full transition-[clip-path] duration-700 ease-out',
            TONES[tone],
          )}
          style={{ clipPath: `inset(0 ${100 - percent}% 0 0 round 9999px)` }}
        >
          {active && percent > 0 && (
            <div className="absolute inset-0 animate-progress-sheen bg-gradient-to-r from-transparent via-white/40 to-transparent motion-reduce:hidden" />
          )}
        </div>
      )}
    </div>
  );
}
