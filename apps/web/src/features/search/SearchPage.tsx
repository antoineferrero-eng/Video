import { Search, SearchX } from 'lucide-react';
import { useDeferredValue } from 'react';
import { useSearchParams } from 'react-router';
import type { TitleKind } from '@lumiere/shared';
import { useTitleSearch } from '../../api/queries';
import { POSTER_GRID } from '../../components/media/grid';
import { PosterCard, PosterCardSkeleton } from '../../components/media/PosterCard';
import { EmptyState } from '../../components/ui/States';
import { Glass } from '../../design/glass/Glass';
import { plural } from '../../lib/format';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('q') ?? '';
  const query = useDeferredValue(raw);
  const movies = useTitleSearch(query, 'movie');
  const series = useTitleSearch(query, 'series');
  const loading = movies.isPending || series.isPending;
  const total = (movies.data?.total ?? 0) + (series.data?.total ?? 0);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <h1 className="large-title">Recherche</h1>
        {/* Sur grand écran, le champ de la barre d'outils pilote la recherche. */}
        <Glass className="glass-field flex h-12 items-center gap-3 rounded-full px-4 lg:hidden">
          <Search className="size-5 shrink-0 text-zinc-300" aria-hidden="true" />
          <input
            type="search"
            value={raw}
            autoFocus={!raw}
            onChange={(event) =>
              setParams(event.target.value ? { q: event.target.value } : {}, { replace: true })
            }
            placeholder="Films, séries…"
            aria-label="Rechercher un film ou une série"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-zinc-400"
          />
        </Glass>
        <p className="text-sm text-zinc-400">
          {query
            ? loading
              ? 'Recherche…'
              : `${plural(total, 'résultat')} pour « ${query} »`
            : 'Saisissez un titre : la recherche ignore les accents et les majuscules.'}
        </p>
      </header>
      {query && !loading && total === 0 && (
        <EmptyState
          icon={<SearchX />}
          title="Aucun résultat"
          description="Vérifiez l'orthographe ou essayez le titre original : la recherche couvre tous les films et séries de TMDB."
        />
      )}
      <ResultSection title="Films" kind="movie" result={movies} />
      <ResultSection title="Séries" kind="series" result={series} />
    </div>
  );
}

function ResultSection({
  title,
  result,
}: {
  title: string;
  kind: TitleKind;
  result: ReturnType<typeof useTitleSearch>;
}) {
  if (result.isPending && result.fetchStatus === 'fetching') {
    return (
      <div className={POSTER_GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <PosterCardSkeleton key={index} />
        ))}
      </div>
    );
  }
  const items = result.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-bold tracking-tight">
        {title} <span className="text-base font-medium text-zinc-400">({result.data?.total})</span>
      </h2>
      <div className={POSTER_GRID}>
        {items.map((item) => (
          <PosterCard key={item.id} title={item} />
        ))}
      </div>
    </section>
  );
}
