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
        'fill flex flex-col items-center justify-center gap-3 rounded-card px-6 py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 flex size-16 items-center justify-center rounded-full bg-gradient-to-b from-white/[0.14] to-white/[0.04] text-zinc-200 shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_10px_24px_-12px_rgb(0_0_0/0.8)] [&>svg]:size-7">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-white">{title}</h3>
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
