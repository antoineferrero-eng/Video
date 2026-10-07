import { Play, X } from 'lucide-react';
import { Link } from 'react-router';
import type { ContinueWatchingItem } from '@lumiere/shared';
import { formatClock } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { ProgressBar } from '../ui/ProgressBar';
import { Backdrop } from './Poster';

export function ContinueCard({
  item,
  onRemove,
}: {
  item: ContinueWatchingItem;
  onRemove?: () => void;
}) {
  const progress = item.duration ? item.position / item.duration : null;
  const remaining = item.duration ? item.duration - item.position : null;
  return (
    <div className="group relative w-72 shrink-0 snap-start sm:w-80">
      <Link to={playerUrl(item.media)} className="block rounded-tile outline-none">
        <div className="media-frame aspect-video" data-glow>
          <Backdrop url={item.backdropUrl ?? item.posterUrl} seed={item.title} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
          <PlayBadge />
          <div className="absolute inset-x-0 bottom-0 z-[3] p-3.5">
            <p className="truncate text-sm font-semibold text-white">{item.title}</p>
            <p className="truncate text-xs text-zinc-300">
              {item.subtitle ? `${item.subtitle} · ` : ''}
              {remaining !== null
                ? `${formatClock(remaining)} restantes`
                : formatClock(item.position)}
            </p>
            <ProgressBar value={progress} label="Progression du visionnage" className="mt-2.5 h-1" />
          </div>
        </div>
      </Link>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Retirer de « Reprendre la lecture »"
          aria-label={`Retirer ${item.title} de « Reprendre la lecture »`}
          className="glass glass-clear glass-interactive absolute top-2.5 right-2.5 z-[4] flex size-8 items-center justify-center rounded-full text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Bouton de lecture en verre clair, posé sur l'image au survol. */
export function PlayBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={
        size === 'sm'
          ? 'glass glass-clear absolute top-2.5 right-2.5 z-[3] flex size-10 scale-90 items-center justify-center rounded-full opacity-0 transition duration-300 group-hover:scale-100 group-hover:opacity-100'
          : 'glass glass-clear absolute top-1/2 left-1/2 z-[3] flex size-14 -translate-x-1/2 -translate-y-1/2 scale-90 items-center justify-center rounded-full opacity-0 transition duration-300 group-hover:scale-100 group-hover:opacity-100'
      }
    >
      <Play className={size === 'sm' ? 'ml-0.5 size-4 fill-white' : 'ml-1 size-6 fill-white'} />
    </span>
  );
}
