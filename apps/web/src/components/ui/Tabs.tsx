import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem<T extends string | number> {
  value: T;
  label: ReactNode;
  count?: number;
}

/** Onglets « segmentés » défilants (saisons, catégories…). */
export function Tabs<T extends string | number>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn('scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1', className)}
      role="tablist"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={String(item.value)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition',
              active
                ? 'bg-white text-ink-950 shadow'
                : 'bg-white/[0.05] text-zinc-300 ring-1 ring-inset ring-white/5 hover:bg-white/[0.1] hover:text-white',
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  'rounded-md px-1.5 text-xs',
                  active ? 'bg-ink-950/10' : 'bg-white/10 text-zinc-400',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
