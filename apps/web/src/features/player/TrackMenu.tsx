import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TrackOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** Menu déroulant du lecteur (pistes audio, sous-titres). */
export function TrackMenu<T>({
  icon,
  label,
  title,
  options,
  value,
  onSelect,
  onOpenChange,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  options: Array<TrackOption<T>>;
  value: T;
  onSelect: (value: T) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={() => setOpen((value) => !value)}
        className={cn('rounded-lg p-2 transition hover:bg-white/10', open && 'bg-white/10')}
      >
        {icon}
      </button>
      {open && (
        <div className="absolute right-0 bottom-12 z-20 w-72 animate-fade-in overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 py-1.5 shadow-2xl backdrop-blur-xl">
          <p className="px-4 pt-1.5 pb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            {label}
          </p>
          <div className="max-h-72 overflow-y-auto">
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    onSelect(option.value);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-3 px-4 py-2 text-left text-sm transition hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-4 shrink-0 text-brand-300',
                      !selected && 'invisible',
                    )}
                  />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block',
                        selected ? 'font-semibold text-white' : 'text-zinc-200',
                      )}
                    >
                      {option.label}
                    </span>
                    {option.hint && (
                      <span className="block text-xs text-zinc-500">{option.hint}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
