import { ArrowUpDown, Film, RefreshCw, Search, Tv } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { CatalogSort, TitleKind } from '@lumiere/shared';
import { useCatalog, useGenres, useRefreshCatalog, useSystemInfo } from '../../api/queries';
import { POSTER_GRID } from '../../components/media/grid';
import { PosterCard, PosterCardSkeleton } from '../../components/media/PosterCard';
import { Button } from '../../components/ui/Button';
import { Menu } from '../../components/ui/Menu';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { cn } from '../../lib/cn';
import { formatRelativeDate, plural } from '../../lib/format';
import { SetupBanner, SetupCard } from '../setup/SetupCard';
import { useSetupStatus } from '../setup/setup-status';

const SORTS: Array<{ value: CatalogSort; label: string; hint?: string }> = [
  { value: 'popular', label: 'Popularité', hint: 'Comme la page « Populaires » de TMDB' },
  { value: 'recent', label: 'Sorties récentes' },
  { value: 'title', label: 'Titre (A → Z)' },
  { value: 'year', label: 'Année' },
  { value: 'rating', label: 'Note' },
];

/** Tri mémorisé par section (préférence de cet appareil) ; popularité par défaut. */
function storedSort(kind: TitleKind): CatalogSort {
  try {
    const value = localStorage.getItem(`lumiere.sort.${kind}`);
    return SORTS.some((option) => option.value === value) ? (value as CatalogSort) : 'popular';
  } catch {
    return 'popular';
  }
}

function storeSort(kind: TitleKind, sort: CatalogSort): void {
  try {
    localStorage.setItem(`lumiere.sort.${kind}`, sort);
  } catch {
    // Stockage indisponible (navigation privée) : le tri n'est pas mémorisé.
  }
}

export function CatalogPage({ kind }: { kind: TitleKind }) {
  const [q, setQ] = useState('');
  const [sort, setSortState] = useState<CatalogSort>(() => storedSort(kind));
  const setSort = (value: CatalogSort) => {
    setSortState(value);
    storeSort(kind, value);
  };
  const [genre, setGenre] = useState<string | undefined>();
  const deferredQ = useDeferredValue(q.trim());
  const catalog = useCatalog({ kind, q: deferredQ || undefined, sort, genre });
  const genres = useGenres(kind);
  const system = useSystemInfo();
  const refresh = useRefreshCatalog();
  const section = system.data?.catalog.find((item) => item.kind === kind);
  const setup = useSetupStatus();
  const needsSetup = setup !== null && !setup.complete;
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
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="large-title flex items-center gap-3">
            <Icon className="size-7 text-brand-300" />
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
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder={`Filtrer les ${label.toLowerCase()}…`}
              aria-label={`Filtrer les ${label.toLowerCase()}`}
              className="input pl-10"
            />
          </div>
          <Menu
            header="Trier par"
            options={SORTS}
            value={sort}
            onSelect={setSort}
            trigger={({ toggle, aria }) => (
              <Button
                variant="glass"
                size="md"
                icon={<ArrowUpDown className="size-4" />}
                onClick={toggle}
                className="h-11"
                {...aria}
              >
                {SORTS.find((option) => option.value === sort)?.label}
              </Button>
            )}
          />
          <Button
            variant="glass"
            size="icon"
            className="size-11"
            onClick={() => refresh.mutate(kind)}
            disabled={section?.state === 'refreshing'}
            title="Réimporter les listes de TMDB"
            aria-label="Actualiser le catalogue"
          >
            <RefreshCw
              className={cn('size-4', section?.state === 'refreshing' && 'animate-spin')}
            />
          </Button>
        </div>
      </header>

      {(genres.data?.length ?? 0) > 0 && (
        <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 py-1">
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

      {needsSetup && items.length > 0 && <SetupBanner status={setup} />}

      {catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : catalog.isPending ? (
        <div className={POSTER_GRID}>
          {Array.from({ length: 14 }, (_, index) => (
            <PosterCardSkeleton key={index} />
          ))}
        </div>
      ) : items.length === 0 && needsSetup && !deferredQ && !genre ? (
        <SetupCard status={setup} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon />}
          title={deferredQ || genre ? 'Aucun résultat' : `Aucun titre dans « ${label} »`}
          description={
            deferredQ || genre
              ? 'Essayez un autre mot-clé ou retirez le filtre de genre.'
              : section?.lastError
                ? `Dernière erreur : ${section.lastError}`
                : 'Le catalogue est vide pour le moment. Vérifiez la clé TMDB dans les paramètres.'
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
      aria-pressed={active}
      className={cn(
        'flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition duration-200 active:scale-[0.97]',
        active
          ? 'bg-white text-ink-950 shadow-[0_6px_18px_-8px_rgb(255_255_255/0.5)]'
          : 'fill text-zinc-200 hover:bg-white/[0.12]',
      )}
    >
      {children}
    </button>
  );
}
