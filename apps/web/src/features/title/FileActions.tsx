import { Check, Download, Eye, EyeOff, Loader2, Pause, Play, RotateCw } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { RemoteFile } from '@lumiere/shared';
import { useDownloadAction, useEnqueueFiles, useSetWatched } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { mediaRefFor, useLiveDownload } from './file-utils';

export function PlayButton({
  file,
  size = 'sm',
  label = 'Lecture',
}: {
  file: RemoteFile;
  size?: 'sm' | 'md' | 'lg';
  label?: string | null;
}) {
  const navigate = useNavigate();
  const watch = file.availability.watch;
  const resume = watch && !watch.completed && watch.position > 30;
  return (
    <Button
      variant="primary"
      size={label === null ? 'icon-sm' : size}
      icon={<Play className="size-4 fill-current" />}
      onClick={() => navigate(playerUrl(mediaRefFor(file)))}
      title={
        resume
          ? `Reprendre à ${formatClock(watch.position)}`
          : 'Regarder (en streaming ou depuis la copie locale)'
      }
    >
      {label === null ? null : resume ? `Reprendre` : label}
    </Button>
  );
}

/** Bouton d'état/de lancement du téléchargement d'un fichier distant. */
export function DownloadState({
  file,
  titleId,
  compact = false,
}: {
  file: RemoteFile;
  titleId: number;
  compact?: boolean;
}) {
  const enqueue = useEnqueueFiles();
  const action = useDownloadAction();
  const live = useLiveDownload(file);
  const libraryItemId = live?.libraryItemId ?? file.availability.libraryItemId;

  if (libraryItemId !== null) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-400/10 px-3 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-400/25 ring-inset">
        <Check className="size-3.5" strokeWidth={3} />
        {!compact && 'Téléchargé'}
      </span>
    );
  }
  if (
    live &&
    (live.status === 'downloading' || live.status === 'queued' || live.status === 'paused')
  ) {
    const percent = live.progress !== null ? Math.round(live.progress * 100) : null;
    return (
      <Link
        to="/telechargements"
        className="flex h-8 min-w-36 flex-col justify-center gap-1 rounded-lg bg-white/[0.05] px-3 ring-1 ring-white/10 ring-inset hover:bg-white/10"
        title="Voir les téléchargements"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-200">
          {live.status === 'downloading' && (
            <Loader2 className="size-3 animate-spin text-brand-300" />
          )}
          {live.status === 'paused' && <Pause className="size-3 text-zinc-400" />}
          {live.status === 'queued'
            ? 'En attente'
            : live.status === 'paused'
              ? 'En pause'
              : 'Téléchargement'}
          {percent !== null && <span className="ml-auto text-zinc-400">{percent} %</span>}
        </span>
        <ProgressBar
          value={live.progress}
          className="h-1"
          tone={live.status === 'paused' ? 'muted' : 'brand'}
        />
      </Link>
    );
  }
  if (live?.status === 'failed') {
    return (
      <Button
        size="sm"
        variant="danger"
        icon={<RotateCw className="size-3.5" />}
        loading={action.isPending}
        onClick={() => action.mutate({ id: live.id, action: 'resume' })}
        title="Le téléchargement a échoué : réessayer"
      >
        {!compact && 'Réessayer'}
      </Button>
    );
  }
  return (
    <Button
      size={compact ? 'icon-sm' : 'sm'}
      icon={<Download className="size-4" />}
      loading={enqueue.isPending}
      onClick={() => enqueue.mutate([{ path: file.path, titleId }])}
      title="Télécharger dans la bibliothèque"
    >
      {!compact && 'Télécharger'}
    </Button>
  );
}

export function WatchedToggle({ file }: { file: RemoteFile }) {
  const setWatched = useSetWatched();
  const watched = file.availability.watch?.completed ?? false;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setWatched.mutate({ media: mediaRefFor(file), watched: !watched })}
      title={watched ? 'Marquer comme non vu' : 'Marquer comme vu'}
      className={cn(watched && 'text-emerald-300')}
    >
      {watched ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
    </Button>
  );
}

export function WatchProgress({ file, className }: { file: RemoteFile; className?: string }) {
  const watch = file.availability.watch;
  if (!watch || (!watch.completed && watch.position < 30)) return null;
  const value = watch.completed ? 1 : watch.duration ? watch.position / watch.duration : null;
  return (
    <ProgressBar
      value={value}
      tone={watch.completed ? 'success' : 'brand'}
      className={cn('h-1', className)}
    />
  );
}
