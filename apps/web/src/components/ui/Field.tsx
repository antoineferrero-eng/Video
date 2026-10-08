import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Field({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="px-1 text-sm font-medium text-zinc-200">{label}</span>
      {children}
      {description && (
        <span className="px-1 text-xs leading-relaxed text-zinc-400">{description}</span>
      )}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('input', className)} {...props} />;
}

/** Liste déroulante en verre (voir Select.tsx). */
export { Select } from './Select';
