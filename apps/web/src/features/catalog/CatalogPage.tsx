import { Film, RefreshCw, Search, Tv } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { CatalogSort, TitleKind } from '@lumiere/shared';
import { useCatalog, useGenres, useRefreshCatalog, useSystemInfo } from '../../api/queries';
import { POSTER_GRID } from '../../components/media/grid';
import { PosterCard, PosterCardSkeleton } from '../../components/media/PosterCard';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { cn } from '../../lib/cn';
import { formatRelativeDate, plural } from '../../lib/format';

const SORTS: Array<{ value: CatalogSort; label: string }> = [
  { value: 'recent', label: 'Ajouts récents' },
  { value: 'title', label: 'Titre (A → Z)' },
  { value: 'year', label: 'Année' },
  { value: 'rating', label: 'Note' },
];

export function CatalogPage({ kind }: { kind: TitleKind }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<CatalogSort>('recent');
  const [genre, setGenre] = useState<string | undefined>();
  const deferredQ = useDeferredValue(q.trim());
  const catalog = useCatalog({ kind, q: deferredQ || undefined, sort, genre });
  const genres = useGenres(kind);
  const system = useSystemInfo();
  const refresh = useRefreshCatalog();
  const section = system.data?.catalog.find((item) => item.kind === kind);
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = catalog;

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '800px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const items = catalog.data?.pages.flatMap((page) => page.items) ?? [];
  const total = catalog.data?.pages[0]?.total ?? 0;
  const label = kind === 'movie' ? 'Films' : 'Séries';
  const Icon = kind === 'movie' ? Film : Tv;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 pt-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight">
            <Icon className="size-7 text-brand-400" />
            {label}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {catalog.isPending
              ? 'Chargement…'
              : plural(total, kind === 'movie' ? 'titre' : 'série')}
            {section?.lastRefreshAt &&
              ` · catalogue actualisé ${formatRelativeDate(section.lastRefreshAt)}`}
            {section?.state === 'refreshing' && ' · actualisation en cours…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder={`Filtrer les ${label.toLowerCase()}…`}
              className="input h-10 pl-9"
            />
          </div>
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value as CatalogSort)}
            className="h-10 w-44"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            icon={
              <RefreshCw
                className={cn('size-4', section?.state === 'refreshing' && 'animate-spin')}
              />
            }
            onClick={() => refresh.mutate(kind)}
            disabled={section?.state === 'refreshing'}
            title="Relire la liste depuis la source"
          >
            Actualiser
          </Button>
        </div>
      </header>

      {(genres.data?.length ?? 0) > 0 && (
        <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          <GenreChip active={!genre} onClick={() => setGenre(undefined)}>
            Tous
          </GenreChip>
          {genres.data?.map((item) => (
            <GenreChip
              key={item.name}
              active={genre === item.name}
              onClick={() => setGenre(item.name)}
            >
              {item.name}
              <span className="text-xs opacity-60">{item.count}</span>
            </GenreChip>
          ))}
        </div>
      )}

      {catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : catalog.isPending ? (
        <div className={POSTER_GRID}>
          {Array.from({ length: 14 }, (_, index) => (
            <PosterCardSkeleton key={index} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon />}
          title={deferredQ || genre ? 'Aucun résultat' : `Aucun titre dans « ${label} »`}
          description={
            deferredQ || genre
              ? 'Essayez un autre mot-clé ou retirez le filtre de genre.'
              : section?.lastError
                ? `Dernière erreur : ${section.lastError}`
                : 'Le catalogue est vide pour le moment. Vérifiez la source dans les paramètres.'
          }
        />
      ) : (
        <div
          className={cn(POSTER_GRID, catalog.isPlaceholderData && 'opacity-60 transition-opacity')}
        >
          {items.map((title) => (
            <PosterCard key={title.id} title={title} />
          ))}
        </div>
      )}

      <div ref={sentinel} className="flex justify-center py-6">
        {isFetchingNextPage && <Spinner className="text-brand-400" />}
      </div>
    </div>
  );
}

function GenreChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition',
        active
          ? 'bg-brand-400 text-ink-950'
          : 'bg-white/[0.05] text-zinc-300 ring-1 ring-inset ring-white/10 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}
