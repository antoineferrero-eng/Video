import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 px-6 py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 rounded-2xl bg-white/[0.04] p-4 text-zinc-400 [&>svg]:size-8">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
      {description && <div className="max-w-md text-sm text-zinc-400">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Une erreur est survenue',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <EmptyState
      icon={<AlertTriangle className="text-red-300" />}
      title={title}
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button onClick={onRetry} icon={<RotateCw className="size-4" />}>
            Réessayer
          </Button>
        )
      }
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}
