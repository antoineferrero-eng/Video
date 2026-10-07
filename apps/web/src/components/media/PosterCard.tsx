import { Check, Star } from 'lucide-react';
import { Link } from 'react-router';
import type { TitleSummary } from '@lumiere/shared';
import { cn } from '../../lib/cn';
import { formatRating } from '../../lib/format';
import { Poster } from './Poster';

export function PosterCard({ title, className }: { title: TitleSummary; className?: string }) {
  const rating = formatRating(title.rating);
  return (
    <Link
      to={`/titre/${title.id}`}
      className={cn('group flex flex-col gap-2.5 rounded-tile outline-none', className)}
      title={title.title}
    >
      <div
        className={cn('media-frame', title.sourceStatus === 'missing' && 'opacity-45 saturate-50')}
        data-glow
      >
        <Poster
          url={title.posterUrl}
          title={title.title}
          year={title.year}
          kind={title.kind}
        />
        {title.sourceStatus === 'missing' && (
          <span
            className="absolute top-2 left-2 z-[3] rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-zinc-100 backdrop-blur-md"
            title="Ce titre n’a pas été trouvé sur la source"
          >
            Introuvable
          </span>
        )}
        {title.libraryCount > 0 && (
          <span
            className="absolute top-2 right-2 z-[3] flex size-6 items-center justify-center rounded-full bg-emerald-400 text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_4px_10px_rgb(0_0_0/0.4)]"
            title="Présent dans votre bibliothèque"
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        )}
        {rating && (
          <span className="absolute bottom-2 left-2 z-[3] flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100">
            <Star className="size-3 fill-brand-400 text-brand-400" />
            {rating}
          </span>
        )}
      </div>
      <div className="min-w-0 px-1">
        <p className="truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
          {title.title}
        </p>
        <p className="text-xs text-zinc-400">
          {title.year ?? '—'}
          {title.genres[0] ? ` · ${title.genres[0]}` : ''}
        </p>
      </div>
    </Link>
  );
}

export function PosterCardSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="skeleton aspect-[2/3] rounded-tile" />
      <div className="skeleton h-3.5 w-3/4" />
      <div className="skeleton h-3 w-1/3" />
    </div>
  );
}
