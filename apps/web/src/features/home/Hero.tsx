import { Download, Info, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { TitleSummary } from '@lumiere/shared';
import { useEnqueueTitle } from '../../api/queries';
import { Backdrop, Poster } from '../../components/media/Poster';
import { Button, ButtonLink } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import { formatRating } from '../../lib/format';

/** Bandeau d'accueil : titres récents mis en avant, en rotation automatique. */
export function Hero({ titles }: { titles: TitleSummary[] }) {
  const [index, setIndex] = useState(0);
  const enqueue = useEnqueueTitle();
  const current = titles[index % titles.length];

  useEffect(() => {
    if (titles.length < 2) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % titles.length), 9000);
    return () => window.clearInterval(timer);
  }, [titles.length]);

  if (!current) return null;
  const rating = formatRating(current.rating);

  return (
    <section className="relative -mx-4 -mt-4 h-[58vh] max-h-[680px] min-h-[420px] overflow-hidden sm:-mx-8">
      <Backdrop
        key={current.id}
        url={current.backdropUrl}
        seed={current.title}
        className={cn('scale-105', !current.backdropUrl && 'opacity-70 blur-2xl')}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/70 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-transparent to-ink-950/30" />
      {!current.backdropUrl && (
        <Link
          key={`poster-${current.id}`}
          to={`/titre/${current.id}`}
          className="absolute top-1/2 right-[8%] hidden w-56 -translate-y-1/2 rotate-3 animate-fade-in overflow-hidden rounded-2xl shadow-2xl shadow-black/70 ring-1 ring-white/15 transition hover:rotate-0 lg:block xl:w-64"
        >
          <Poster
            url={current.posterUrl}
            title={current.title}
            year={current.year}
            kind={current.kind}
            eager
          />
        </Link>
      )}

      <div
        key={`content-${current.id}`}
        className="relative flex h-full max-w-3xl animate-fade-in flex-col justify-end gap-4 px-4 pb-12 sm:px-8 sm:pb-16"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold tracking-wider text-white uppercase backdrop-blur">
            {current.kind === 'movie' ? 'Film' : 'Série'}
          </span>
          {current.year && <span>{current.year}</span>}
          {rating && (
            <span className="flex items-center gap-1">
              <Star className="size-3.5 fill-brand-400 text-brand-400" />
              {rating}
            </span>
          )}
          {current.genres.slice(0, 3).map((genre) => (
            <span key={genre} className="text-zinc-400">
              · {genre}
            </span>
          ))}
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight text-balance text-white drop-shadow-lg sm:text-5xl lg:text-6xl">
          {current.title}
        </h1>
        {current.overview && (
          <p className="line-clamp-3 max-w-2xl text-sm leading-relaxed text-zinc-300 sm:text-base">
            {current.overview}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-3">
          <ButtonLink
            to={`/titre/${current.id}`}
            variant="primary"
            size="lg"
            icon={<Info className="size-5" />}
          >
            Voir la fiche
          </ButtonLink>
          <Button
            variant="glass"
            size="lg"
            icon={<Download className="size-5" />}
            loading={enqueue.isPending}
            onClick={() => enqueue.mutate({ titleId: current.id })}
          >
            {current.kind === 'movie' ? 'Télécharger' : 'Tout télécharger'}
          </Button>
        </div>
      </div>

      {titles.length > 1 && (
        <div className="absolute right-4 bottom-6 flex gap-1.5 sm:right-8">
          {titles.map((title, position) => (
            <button
              key={title.id}
              type="button"
              aria-label={`Afficher ${title.title}`}
              onClick={() => setIndex(position)}
              className={cn(
                'h-1.5 rounded-full transition-all',
                position === index % titles.length
                  ? 'w-8 bg-brand-400'
                  : 'w-3 bg-white/30 hover:bg-white/60',
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}
