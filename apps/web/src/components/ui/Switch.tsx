import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Interrupteur façon iOS 26 : pendant l'appui, le curseur s'étire et devient une lentille
 * de verre (HIG : les commandes du contenu adoptent le verre quand on les active).
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-zinc-100">
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{description}</p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-checked={checked}
        className={cn(
          'switch group relative h-[31px] w-[51px] shrink-0 rounded-full p-[2px] transition-colors duration-300 disabled:opacity-40',
          checked
            ? 'bg-brand-400 shadow-[inset_0_1px_1px_rgb(120_53_15/0.35)]'
            : 'bg-white/[0.16] shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)]',
        )}
      >
        <span aria-hidden="true" className="switch-knob" />
      </button>
    </div>
  );
}
