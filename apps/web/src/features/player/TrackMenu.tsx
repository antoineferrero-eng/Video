import type { ReactNode } from 'react';
import { Menu, type MenuOption } from '../../components/ui/Menu';
import { cn } from '../../lib/cn';

export type TrackOption<T> = MenuOption<T>;

/** Menu du lecteur (pistes audio, sous-titres) : verre épais qui jaillit du bouton. */
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
  return (
    <Menu
      header={label}
      options={options}
      value={value}
      onSelect={onSelect}
      onOpenChange={onOpenChange}
      placement="top-end"
      trigger={({ open, toggle, aria }) => (
        <button
          type="button"
          title={title}
          aria-label={title}
          onClick={toggle}
          {...aria}
          className={cn(
            'flex size-10 items-center justify-center rounded-full transition hover:bg-white/[0.14] active:scale-95',
            open && 'bg-white/[0.16]',
          )}
        >
          {icon}
        </button>
      )}
    />
  );
}
