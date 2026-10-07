import { AlertTriangle, Film, Play, Settings } from 'lucide-react';
import { Link } from 'react-router';
import type { LibraryItem } from '@lumiere/shared';
import { useContinueWatching, useHome, useLibrary, useRemoveProgress } from '../../api/queries';
import { ContinueCard } from '../../components/media/ContinueCard';
import { MediaRow } from '../../components/media/MediaRow';
import { Backdrop } from '../../components/media/Poster';
import { PosterCard, PosterCardSkeleton } from '../../components/media/PosterCard';
import { ButtonLink } from '../../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { episodeCode, formatBytes } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { Hero } from './Hero';

export function HomePage() {
  const home = useHome();
  const continueWatching = useContinueWatching();
  const library = useLibrary();
  const removeProgress = useRemoveProgress();

  if (home.isPending) return <HomeSkeleton />;
  if (home.isError) return <ErrorState error={home.error} onRetry={() => void home.refetch()} />;

  const feed = home.data;
  const failing = feed.sections.filter((section) => section.state === 'error');
  const isEmpty = feed.recentMovies.length === 0 && feed.recentSeries.length === 0;
  const recentLibrary = (library.data ?? []).filter((item) => item.exists).slice(0, 16);

  return (
    <div className="flex flex-col gap-10">
      {feed.featured.length > 0 && <Hero titles={feed.featured} />}

      {failing.length > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-red-400/20 bg-red-500/[0.06] p-5 sm:flex-row sm:items-center">
          <AlertTriangle className="size-6 shrink-0 text-red-300" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-red-200">Le catalogue n'a pas pu être actualisé</p>
            {failing.map((section) => (
              <p key={section.kind} className="text-red-200/70">
                {section.kind === 'movie' ? 'Films' : 'Séries'} ({section.path}) :{' '}
                {section.lastError}
              </p>
            ))}
          </div>
          <ButtonLink to="/parametres" size="sm" icon={<Settings className="size-4" />}>
            Vérifier la source
          </ButtonLink>
        </div>
      )}

      {isEmpty && failing.length === 0 && (
        <EmptyState
          icon={<Film />}
          title="Le catalogue est en cours de chargement"
          description="La liste des films et séries est récupérée depuis la source. Cela ne prend généralement que quelques secondes."
        />
      )}

      {(continueWatching.data?.length ?? 0) > 0 && (
        <MediaRow title="Reprendre la lecture">
          {continueWatching.data?.map((item) => (
            <ContinueCard
              key={item.mediaKey}
              item={item}
              onRemove={() => removeProgress.mutate(item.mediaKey)}
            />
          ))}
        </MediaRow>
      )}

      {feed.recentMovies.length > 0 && (
        <MediaRow title="Films récemment ajoutés" action={{ label: 'Tout voir', to: '/films' }}>
          {feed.recentMovies.map((title) => (
            <PosterCard
              key={title.id}
              title={title}
              className="w-36 shrink-0 snap-start sm:w-40 lg:w-44"
            />
          ))}
        </MediaRow>
      )}

      {feed.recentSeries.length > 0 && (
        <MediaRow title="Séries récemment ajoutées" action={{ label: 'Tout voir', to: '/series' }}>
          {feed.recentSeries.map((title) => (
            <PosterCard
              key={title.id}
              title={title}
              className="w-36 shrink-0 snap-start sm:w-40 lg:w-44"
            />
          ))}
        </MediaRow>
      )}

      {recentLibrary.length > 0 && (
        <MediaRow title="Dans ma bibliothèque" action={{ label: 'Tout voir', to: '/bibliotheque' }}>
          {recentLibrary.map((item) => (
            <LibraryTile key={item.id} item={item} />
          ))}
        </MediaRow>
      )}
    </div>
  );
}

function LibraryTile({ item }: { item: LibraryItem }) {
  const code = item.kind === 'episode' ? episodeCode(item.season, item.episode) : null;
  return (
    <Link
      to={playerUrl({ type: 'library', id: item.id })}
      className="group relative w-64 shrink-0 snap-start sm:w-72"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl ring-1 ring-white/[0.06] transition group-hover:ring-brand-400/50">
        <Backdrop
          url={item.backdropUrl ?? item.posterUrl}
          seed={item.title}
          className="transition duration-500 group-hover:scale-[1.03]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <span className="absolute top-2 right-2 flex size-9 items-center justify-center rounded-full bg-white/90 text-ink-950 opacity-0 shadow-xl transition group-hover:opacity-100">
          <Play className="ml-0.5 size-4 fill-current" />
        </span>
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="truncate text-sm font-semibold text-white">{item.title}</p>
          <p className="truncate text-xs text-zinc-300">
            {[code, item.release.resolution, formatBytes(item.size)].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-10">
      <Skeleton className="-mx-4 -mt-4 h-[52vh] rounded-none sm:-mx-8" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <PosterCardSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}
