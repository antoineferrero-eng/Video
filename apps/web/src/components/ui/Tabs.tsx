import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useLiquidIndicator } from '../../design/glass/useLiquidIndicator';
import { cn } from '../../lib/cn';

export interface TabItem<T extends string | number> {
  value: T;
  label: ReactNode;
  count?: number;
}

/**
 * Contrôle segmenté (saisons, catégories, réglages) : une goutte de verre glisse vers le
 * segment choisi. Navigation au clavier avec les flèches ; sémantique d'onglets (« tabs »)
 * ou de boutons radio (« radio ») selon l'usage ; défilement si trop de segments.
 */
export function Tabs<T extends string | number>({
  items,
  value,
  onChange,
  className,
  label,
  kind = 'tabs',
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  label?: string;
  kind?: 'tabs' | 'radio';
}) {
  const radio = kind === 'radio';
  const scroller = useRef<HTMLDivElement>(null);
  const { container: list, indicator } = useLiquidIndicator(String(value));

  // L'onglet actif reste visible quand la liste défile horizontalement.
  useEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    const container = scroller.current;
    if (!active || !container) return;
    const left = active.offsetLeft - 16;
    const right = active.offsetLeft + active.offsetWidth + 16 - container.clientWidth;
    if (container.scrollLeft > left) container.scrollTo({ left, behavior: 'smooth' });
    else if (container.scrollLeft < right) container.scrollTo({ left: right, behavior: 'smooth' });
  }, [value, list]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === value);
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : event.key === 'Home'
            ? -index
            : event.key === 'End'
              ? items.length - 1 - index
              : 0;
    if (!delta) return;
    event.preventDefault();
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;
    onChange(next.value);
    list.current
      ?.querySelector<HTMLElement>(`[data-indicator-key="${CSS.escape(String(next.value))}"]`)
      ?.focus();
  };

  return (
    <div ref={scroller} className={cn('scrollbar-none -mx-1 overflow-x-auto p-1', className)}>
      <div
        ref={list}
        role={radio ? 'radiogroup' : 'tablist'}
        aria-label={label}
        onKeyDown={onKeyDown}
        className="fill relative inline-flex min-w-max items-center gap-0.5 rounded-full p-1"
      >
        <span
          ref={indicator}
          aria-hidden="true"
          className="lens-indicator rounded-full opacity-0"
        />
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={String(item.value)}
              type="button"
              role={radio ? 'radio' : 'tab'}
              aria-selected={radio ? undefined : active}
              aria-checked={radio ? active : undefined}
              data-active={active}
              tabIndex={active ? 0 : -1}
              data-indicator-key={String(item.value)}
              onClick={() => onChange(item.value)}
              className={cn(
                'relative z-[1] flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors duration-200',
                active ? 'text-white' : 'text-zinc-400 hover:text-zinc-100',
              )}
            >
              {item.label}
              {item.count !== undefined && (
                <span
                  className={cn(
                    'min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums',
                    active ? 'bg-white/20 text-white' : 'bg-white/[0.08] text-zinc-400',
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
