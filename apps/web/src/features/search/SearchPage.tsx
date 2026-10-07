import { SearchX } from 'lucide-react';
import { useDeferredValue } from 'react';
import { useSearchParams } from 'react-router';
import type { TitleKind } from '@lumiere/shared';
import { useTitleSearch } from '../../api/queries';
import { PosterCard, PosterCardSkeleton } from '../../components/media/PosterCard';
import { EmptyState } from '../../components/ui/States';
import { plural } from '../../lib/format';
import { POSTER_GRID } from '../../components/media/grid';

export function SearchPage() {
  const [params] = useSearchParams();
  const query = useDeferredValue(params.get('q') ?? '');
  const movies = useTitleSearch(query, 'movie');
  const series = useTitleSearch(query, 'series');
  const loading = movies.isPending || series.isPending;
  const total = (movies.data?.total ?? 0) + (series.data?.total ?? 0);

  return (
    <div className="flex flex-col gap-8 pt-2">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Recherche</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {query
            ? loading
              ? 'Recherche…'
              : `${plural(total, 'résultat')} pour « ${query} »`
            : 'Saisissez un titre dans la barre de recherche.'}
        </p>
      </header>
      {query && !loading && total === 0 && (
        <EmptyState
          icon={<SearchX />}
          title="Aucun résultat"
          description="Vérifiez l'orthographe ou essayez le titre original. Astuce : l'explorateur permet aussi de parcourir la source dossier par dossier."
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
      <h2 className="text-xl font-semibold">
        {title} <span className="text-base font-normal text-zinc-500">({result.data?.total})</span>
      </h2>
      <div className={POSTER_GRID}>
        {items.map((item) => (
          <PosterCard key={item.id} title={item} />
        ))}
      </div>
    </section>
  );
}
