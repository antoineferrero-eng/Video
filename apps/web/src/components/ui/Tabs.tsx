import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLiquidIndicator } from '../../design/glass/useLiquidIndicator';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface TabItem<T extends string | number> {
  value: T;
  label: ReactNode;
  count?: number;
}

/**
 * Contrôle segmenté (saisons, catégories, réglages) : une goutte de verre glisse vers le
 * segment choisi. Navigation au clavier avec les flèches ; sémantique d'onglets (« tabs »)
 * ou de boutons radio (« radio ») selon l'usage. Trop de segments pour la largeur (les 38
 * saisons d'une série…) : la rangée défile, avec un fondu et une flèche du côté des segments
 * cachés, et à la molette (une souris ne défile pas latéralement).
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
  /** Segments cachés au début et à la fin de la rangée. */
  const [hidden, setHidden] = useState({ start: false, end: false });

  useEffect(() => {
    const container = scroller.current;
    if (!container) return;
    const update = () => {
      const max = container.scrollWidth - container.clientWidth;
      const start = container.scrollLeft > 1;
      const end = container.scrollLeft < max - 1;
      setHidden((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    // Molette verticale : la rangée défile, puis la page une fois au bord.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = container.scrollWidth - container.clientWidth;
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const left = Math.min(max, Math.max(0, container.scrollLeft + delta));
      if (Math.abs(left - container.scrollLeft) < 1) return;
      event.preventDefault();
      container.scrollLeft = left;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    if (list.current) observer.observe(list.current);
    container.addEventListener('scroll', update, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', update);
      container.removeEventListener('wheel', onWheel);
    };
  }, [list]);

  const scrollPage = (direction: 1 | -1) => {
    const container = scroller.current;
    if (container)
      container.scrollBy({ left: direction * container.clientWidth * 0.75, behavior: 'smooth' });
  };
  // Fondu du côté des segments cachés, sous la flèche.
  const fade = `linear-gradient(to right, ${hidden.start ? 'transparent, #000 4rem' : '#000'}, ${
    hidden.end ? '#000 calc(100% - 4rem), transparent' : '#000'
  })`;

  // L'onglet actif reste visible quand la liste défile horizontalement, hors du fondu et des
  // flèches des bords.
  useEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    const container = scroller.current;
    if (!active || !container) return;
    const left = active.offsetLeft - 56;
    const right = active.offsetLeft + active.offsetWidth + 56 - container.clientWidth;
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
    <div className={cn('relative', className)}>
      <div
        ref={scroller}
        className="scrollbar-none -mx-1 overflow-x-auto p-1"
        style={hidden.start || hidden.end ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
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
      {hidden.start && <ScrollArrow side="start" onClick={() => scrollPage(-1)} />}
      {hidden.end && <ScrollArrow side="end" onClick={() => scrollPage(1)} />}
    </div>
  );
}

/**
 * Flèche posée sur le fondu d'un bord : hors de l'ordre de tabulation, le clavier passant
 * d'un segment à l'autre avec les flèches.
 */
function ScrollArrow({ side, onClick }: { side: 'start' | 'end'; onClick: () => void }) {
  return (
    <span
      className={cn(
        'absolute inset-y-0 z-[2] flex items-center',
        side === 'start' ? '-left-1' : '-right-1',
      )}
    >
      <Button
        variant="glass"
        size="icon-sm"
        tabIndex={-1}
        aria-label={side === 'start' ? 'Défiler vers la gauche' : 'Défiler vers la droite'}
        onClick={onClick}
      >
        {side === 'start' ? (
          <ChevronLeft className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
      </Button>
    </span>
  );
}
