import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';

export interface MenuOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

type Placement = 'bottom-end' | 'bottom-start' | 'top-end';

const PLACEMENTS: Record<Placement, string> = {
  'bottom-end': 'top-[calc(100%+0.5rem)] right-0 origin-top-right',
  'bottom-start': 'top-[calc(100%+0.5rem)] left-0 origin-top-left',
  'top-end': 'bottom-[calc(100%+0.75rem)] right-0 origin-bottom-right',
};

/**
 * Menu de choix en verre épais, qui « jaillit » de son bouton (HIG : les menus naissent de
 * la commande qui les ouvre). Clavier : flèches, Début/Fin, Échap.
 */
export function Menu<T>({
  trigger,
  header,
  options,
  value,
  onSelect,
  placement = 'bottom-end',
  onOpenChange,
  className,
}: {
  trigger: (props: {
    open: boolean;
    toggle: () => void;
    aria: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls'?: string };
  }) => ReactNode;
  header?: string;
  options: Array<MenuOption<T>>;
  value: T;
  onSelect: (value: T) => void;
  placement?: Placement;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const selected = list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected ?? items?.[0])?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const focusTrigger = () =>
    root.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled)',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape') {
      setOpen(false);
      focusTrigger();
    } else if (event.key === 'Tab') setOpen(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div ref={root} className={cn('relative', className)}>
      {trigger({
        open,
        toggle: () => setOpen((current) => !current),
        aria: {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
        },
      })}
      {open && (
        <Glass
          variant="thick"
          className={cn(
            'absolute z-40 w-72 max-w-[calc(100vw-2rem)] animate-materialize rounded-card p-1.5',
            PLACEMENTS[placement],
          )}
        >
          <div id={id} ref={list} role="menu" aria-label={header} onKeyDown={onKeyDown}>
            {header && (
              <p className="px-3 pt-1.5 pb-1 text-xs font-semibold text-zinc-400">{header}</p>
            )}
            <div className="max-h-72 overflow-y-auto">
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={option.disabled}
                    onClick={() => {
                      onSelect(option.value);
                      setOpen(false);
                      focusTrigger();
                    }}
                    className="flex w-full items-start gap-3 rounded-inner px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-white/[0.09] focus-visible:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
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
                          selected ? 'font-semibold text-white' : 'text-zinc-100',
                        )}
                      >
                        {option.label}
                      </span>
                      {option.hint && (
                        <span className="block text-xs text-zinc-400">{option.hint}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Glass>
      )}
    </div>
  );
}
