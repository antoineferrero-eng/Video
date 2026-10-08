import { Check, ChevronDown } from 'lucide-react';
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';

interface OptionData {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

/** Texte d'un contenu React (recherche au clavier par la première lettre). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Options déclarées comme pour un `<select>` : `<option value="…">Libellé</option>`. */
function readOptions(children: ReactNode): OptionData[] {
  return Children.toArray(children)
    .filter(
      (
        child,
      ): child is ReactElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }> => isValidElement(child) && child.type === 'option',
    )
    .map((child) => ({
      value: String(child.props.value ?? textOf(child.props.children)),
      label: child.props.children,
      text: textOf(child.props.children),
      disabled: Boolean(child.props.disabled),
    }));
}

interface Position {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const GAP = 6;
const MAX_HEIGHT = 320;

function placeBelowOrAbove(trigger: HTMLElement): Position {
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - GAP - 12;
  const above = rect.top - GAP - 12;
  const width = Math.max(rect.width, 200);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  if (below >= Math.min(MAX_HEIGHT, 200) || below >= above) {
    return { left, width, top: rect.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) };
  }
  return {
    left,
    width,
    bottom: window.innerHeight - rect.top + GAP,
    maxHeight: Math.min(MAX_HEIGHT, above),
  };
}

export interface SelectProps {
  value: string | number;
  /** Même forme que l'événement d'un `<select>` natif (`event.target.value`). */
  onChange: (event: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * Liste déroulante en verre épais, à la place du `<select>` natif (dont la liste suit le
 * thème du système : blanche sous Windows). Motif « combobox à sélection seule » de l'ARIA :
 * le focus reste sur le bouton, l'option active est annoncée par `aria-activedescendant`.
 * Clavier : flèches, Début/Fin, Entrée/Espace, Échap, Tab, première lettre d'une option.
 */
export function Select({
  value,
  onChange,
  children,
  disabled = false,
  className,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  const options = readOptions(children);
  const selectedIndex = options.findIndex((option) => option.value === String(value));
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<Position | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  const show = () => {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== String(value)) onChange({ target: { value: option.value } });
    close();
    trigger.current?.focus({ preventScroll: true });
  };

  // Position calculée à l'ouverture, et suivie au défilement ou au redimensionnement.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const update = () => trigger.current && setPosition(placeBelowOrAbove(trigger.current));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Fermeture au clic en dehors.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Option active toujours visible.
  useEffect(() => {
    if (!open || active < 0) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active, position]);

  const move = (from: number, step: 1 | -1) => {
    for (let index = from + step; index >= 0 && index < options.length; index += step) {
      if (!options[index]?.disabled) return index;
    }
    return from;
  };

  const typeAhead = (key: string) => {
    const now = Date.now();
    typed.current = {
      text: now - typed.current.at < 700 ? typed.current.text + key : key,
      at: now,
    };
    const search = typed.current.text.toLocaleLowerCase('fr');
    const start = open ? active : selectedIndex;
    const ordered = [...options.keys()].map((offset) => (start + 1 + offset) % options.length);
    const match = ordered.find(
      (index) =>
        !options[index]?.disabled &&
        options[index]?.text.toLocaleLowerCase('fr').startsWith(search),
    );
    if (match === undefined) return;
    if (open) setActive(match);
    else choose(match);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(key)) {
        event.preventDefault();
        show();
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeAhead(key);
      }
      return;
    }
    if (key === 'ArrowDown') setActive((index) => move(index, 1));
    else if (key === 'ArrowUp') setActive((index) => move(index, -1));
    else if (key === 'Home') setActive(move(-1, 1));
    else if (key === 'End') setActive(move(options.length, -1));
    else if (key === 'Enter' || key === ' ') choose(active);
    else if (key === 'Escape') close();
    else if (key === 'Tab') {
      close();
      return;
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeAhead(key);
    } else return;
    event.preventDefault();
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cn(
          'input flex cursor-pointer items-center justify-between gap-2 pr-3 text-left disabled:cursor-not-allowed disabled:opacity-50',
          open && 'bg-white/[0.09]',
          className,
        )}
      >
        <span className="min-w-0 truncate">{selected?.label ?? ''}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-zinc-300 transition-transform duration-300 ease-spring',
            open && 'rotate-180',
          )}
        />
      </button>
      {open &&
        position &&
        createPortal(
          <Glass
            variant="thick"
            // Pas de réfraction sur une liste de choix : le flou seul garde le texte lisible.
            lens={false}
            ref={(node) => {
              list.current = node as HTMLDivElement | null;
            }}
            className="fixed z-[70] animate-materialize overflow-hidden rounded-[1.25rem] p-1.5 [--_alpha:max(var(--lg-thick-alpha),0.82)]"
            style={{
              left: position.left,
              width: position.width,
              top: position.top,
              bottom: position.bottom,
              transformOrigin: position.top !== undefined ? 'top center' : 'bottom center',
            }}
            // Le focus reste sur le bouton (clic sur une option compris).
            onMouseDown={(event) => event.preventDefault()}
          >
            <div
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: position.maxHeight - 12 }}
            >
              {options.map((option, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={option.value}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onPointerEnter={() => !option.disabled && setActive(index)}
                    onClick={() => choose(index)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-[0.85rem] px-3 py-2 text-sm transition-colors select-none',
                      index === active ? 'bg-white/[0.12] text-white' : 'text-zinc-100',
                      isSelected && 'font-semibold text-white',
                      option.disabled && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <Check
                      aria-hidden
                      className={cn('size-4 shrink-0 text-brand-300', !isSelected && 'invisible')}
                    />
                    <span className="min-w-0 truncate">{option.label}</span>
                  </div>
                );
              })}
            </div>
          </Glass>,
          document.body,
        )}
    </>
  );
}
