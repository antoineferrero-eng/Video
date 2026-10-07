import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useLens } from '../../design/glass/useLens';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * Fenêtre modale accessible (élément natif <dialog>) en verre épais : grands rayons
 * concentriques, apparition par « matérialisation » plutôt qu'en fondu.
 */
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
  useLens(ref, { bezel: 24, strength: 18 });

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
        'glass glass-thick fixed m-auto w-[min(92vw,34rem)] rounded-[2rem] p-0 text-zinc-100 backdrop:bg-black/55 open:animate-materialize',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <h2 className="text-lg leading-snug font-semibold">{title}</h2>
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={onClose}
          aria-label="Fermer"
          className="-mt-1 -mr-2"
        >
          <X className="size-4" />
        </Button>
      </div>
      {children && <div className="px-6 pt-3 pb-2 text-sm text-zinc-300">{children}</div>}
      {footer && <div className="flex flex-wrap justify-end gap-2 px-6 pt-4 pb-6">{footer}</div>}
    </dialog>
  );
}
