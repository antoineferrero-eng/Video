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

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'input cursor-pointer appearance-none bg-[length:16px] bg-[right_0.9rem_center] bg-no-repeat pr-10',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23d4d4d8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
