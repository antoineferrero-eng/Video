import { Download, Info, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { TitleSummary } from '@lumiere/shared';
import { useEnqueueTitle } from '../../api/queries';
import { Backdrop, Poster } from '../../components/media/Poster';
import { Button, ButtonLink } from '../../components/ui/Button';
import { useAmbient } from '../../design/ambient/ambient';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';
import { formatRating } from '../../lib/format';

/**
 * Bandeau d'accueil : titres récents en rotation. L'illustration s'étend sous la barre
 * latérale et la barre d'outils (extension d'arrière-plan) et colore l'ambiance de la page.
 */
export function Hero({ titles }: { titles: TitleSummary[] }) {
  const [index, setIndex] = useState(0);
  const enqueue = useEnqueueTitle();
  const current = titles[index % titles.length];
  useAmbient(current?.backdropUrl ?? current?.posterUrl, current?.title);

  useEffect(() => {
    if (titles.length < 2) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % titles.length), 9000);
    return () => window.clearInterval(timer);
  }, [titles.length]);

  if (!current) return null;
  const rating = formatRating(current.rating);

  return (
    <section className="bleed bleed-top relative flex h-[clamp(32rem,74vh,48rem)] flex-col justify-end overflow-hidden">
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,#000_58%,transparent)]">
        <Backdrop
          key={current.id}
          url={current.backdropUrl}
          seed={current.title}
          className={cn('scale-105', !current.backdropUrl && 'opacity-70 blur-2xl')}
        />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgb(0_0_0/0.25),rgb(0_0_0/0.72)_var(--inset-left),rgb(0_0_0/0.3)_60%,transparent_85%)]" />
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/45 to-transparent" />
      </div>

      {!current.backdropUrl && (
        <Link
          key={`poster-${current.id}`}
          to={`/titre/${current.id}`}
          className="group absolute top-1/2 right-[8%] hidden w-56 -translate-y-1/2 rotate-3 animate-fade-in rounded-tile transition hover:rotate-0 lg:block xl:w-64"
        >
          <div className="media-frame" data-glow>
            <Poster
              url={current.posterUrl}
              title={current.title}
              year={current.year}
              kind={current.kind}
              eager
            />
          </div>
        </Link>
      )}

      <div
        key={`content-${current.id}`}
        className="relative flex max-w-3xl animate-fade-in flex-col gap-4 pb-14 sm:pb-16"
      >
        <div className="text-shadow-legible flex flex-wrap items-center gap-2 text-sm text-zinc-200">
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold tracking-wider text-white uppercase backdrop-blur-md">
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
            <span key={genre} className="text-zinc-300">
              · {genre}
            </span>
          ))}
        </div>
        <h1 className="text-shadow-legible text-4xl font-extrabold tracking-tight text-balance text-white sm:text-5xl lg:text-6xl">
          {current.title}
        </h1>
        {current.overview && (
          <p className="text-shadow-legible line-clamp-3 max-w-2xl text-sm leading-relaxed text-zinc-200 sm:text-base">
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
        <Glass
          variant="clear"
          lens={false}
          className="absolute right-[var(--inset-right)] bottom-6 flex items-center gap-1.5 rounded-full px-3 py-2.5"
          role="group"
          aria-label="Titres mis en avant"
        >
          {titles.map((title, position) => (
            <button
              key={title.id}
              type="button"
              aria-label={`Afficher ${title.title}`}
              aria-current={position === index % titles.length}
              onClick={() => setIndex(position)}
              className={cn(
                'h-1.5 rounded-full transition-all duration-500 ease-spring',
                position === index % titles.length
                  ? 'w-7 bg-white'
                  : 'w-1.5 bg-white/40 hover:bg-white/70',
              )}
            />
          ))}
        </Glass>
      )}
    </section>
  );
}
