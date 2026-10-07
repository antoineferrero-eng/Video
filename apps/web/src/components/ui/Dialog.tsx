import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/** Fenêtre modale accessible basée sur l'élément natif <dialog>. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[min(92vw,30rem)] rounded-2xl border border-white/10 bg-ink-900 p-0 text-zinc-100 shadow-2xl shadow-black/60 backdrop:bg-black/70 backdrop:backdrop-blur-sm open:animate-fade-in',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer">
          <X className="size-4" />
        </Button>
      </div>
      {children && <div className="px-6 pt-3 pb-2 text-sm text-zinc-300">{children}</div>}
      {footer && <div className="flex justify-end gap-2 px-6 pt-3 pb-5">{footer}</div>}
    </dialog>
  );
}
