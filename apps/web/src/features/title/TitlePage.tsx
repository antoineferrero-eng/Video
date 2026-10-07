import { ArrowLeft, Clock, Download, FolderOpen, Info, Play, Star } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import type { RemoteFile, TitleDetails } from '@lumiere/shared';
import { useEnqueueTitle, useTitle } from '../../api/queries';
import { Backdrop, Poster } from '../../components/media/Poster';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { ErrorState, Skeleton } from '../../components/ui/States';
import { formatClock, formatDuration, formatRating, episodeCode } from '../../lib/format';
import { explorerUrl, playerUrl } from '../../lib/routes';
import { mediaRefFor } from './file-utils';
import { MovieVersions } from './MovieVersions';
import { SeriesSeasons } from './SeriesSeasons';

/** Fichier à lancer avec le bouton principal : film téléchargé ou 1080p, prochain épisode non vu. */
function primaryFile(
  title: TitleDetails,
): { file: RemoteFile; label: string; seasonKey?: string } | null {
  if (title.kind === 'movie') {
    const file =
      title.files.find((item) => item.availability.libraryItemId !== null) ??
      title.files.find((item) => item.release.resolution === '1080p') ??
      title.files[0];
    if (!file) return null;
    const watch = file.availability.watch;
    const resume = watch && !watch.completed && watch.position > 30;
    return { file, label: resume ? `Reprendre à ${formatClock(watch.position)}` : 'Lecture' };
  }
  const seasons = [...title.seasons].sort(
    (a, b) => (a.number === 0 ? 1 : 0) - (b.number === 0 ? 1 : 0),
  );
  for (const season of seasons) {
    for (const episode of season.episodes) {
      const file =
        episode.files.find((item) => item.availability.libraryItemId !== null) ?? episode.files[0];
      if (!file || file.availability.watch?.completed) continue;
      const code = episodeCode(episode.season, episode.episode) ?? episode.title;
      const watch = file.availability.watch;
      const resume = watch && watch.position > 30;
      return {
        file,
        label: resume ? `Reprendre ${code}` : `Lecture ${code}`,
        seasonKey: season.key,
      };
    }
  }
  const first = title.seasons[0]?.episodes[0]?.files[0];
  return first ? { file: first, label: 'Revoir depuis le début' } : null;
}

export function TitlePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useTitle(Number(id));
  const enqueue = useEnqueueTitle();

  if (query.isPending) return <TitleSkeleton />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const title = query.data;
  const primary = primaryFile(title);
  const rating = formatRating(title.rating);
  const episodeCount = title.seasons.reduce((total, season) => total + season.episodes.length, 0);

  return (
    <div className="flex flex-col gap-10">
      <section className="relative -mx-4 -mt-4 overflow-hidden sm:-mx-8">
        <Backdrop url={title.backdropUrl} seed={title.title} className="opacity-60" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/80 to-ink-950/30" />
        <div className="absolute inset-0 bg-gradient-to-r from-ink-950/90 via-ink-950/40 to-transparent" />

        <div className="relative flex flex-col gap-6 px-4 pt-6 pb-10 sm:px-8 md:flex-row md:items-end md:gap-10 md:pt-16">
          <Button
            variant="glass"
            size="icon"
            className="absolute top-4 left-4 sm:left-8"
            onClick={() => navigate(-1)}
            aria-label="Retour"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <Poster
            url={title.posterUrl}
            title={title.title}
            year={title.year}
            kind={title.kind}
            eager
            className="mt-10 w-40 shrink-0 rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 sm:w-52 md:mt-0 lg:w-60"
          />
          <div className="flex min-w-0 flex-1 animate-fade-in flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
              <Badge tone="neutral">{title.kind === 'movie' ? 'Film' : 'Série'}</Badge>
              {title.year && <span>{title.year}</span>}
              {rating && (
                <span className="flex items-center gap-1">
                  <Star className="size-4 fill-brand-400 text-brand-400" />
                  <span className="font-semibold text-white">{rating}</span>
                  <span className="text-zinc-500">/10</span>
                </span>
              )}
              {title.runtime && (
                <span className="flex items-center gap-1 text-zinc-400">
                  <Clock className="size-3.5" />
                  {title.kind === 'movie'
                    ? formatDuration(title.runtime * 60)
                    : `${title.runtime} min / épisode`}
                </span>
              )}
              {title.kind === 'series' && (
                <span className="text-zinc-400">
                  {title.seasons.length} saison(s) · {episodeCount} épisode(s)
                </span>
              )}
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-balance text-white sm:text-5xl">
              {title.title}
            </h1>
            {title.originalTitle && title.originalTitle !== title.title && (
              <p className="-mt-2 text-sm text-zinc-400">Titre original : {title.originalTitle}</p>
            )}
            {title.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {title.genres.map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full bg-white/[0.07] px-3 py-1 text-xs text-zinc-300 ring-1 ring-white/10 ring-inset"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}
            {title.tagline && (
              <p className="text-lg font-medium text-brand-200/90 italic">« {title.tagline} »</p>
            )}
            {title.overview && (
              <p className="max-w-3xl leading-relaxed text-zinc-300">{title.overview}</p>
            )}
            <div className="mt-1 flex flex-wrap gap-3">
              {primary && (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Play className="size-5 fill-current" />}
                  onClick={() => navigate(playerUrl(mediaRefFor(primary.file)))}
                >
                  {primary.label}
                </Button>
              )}
              <Button
                variant="secondary"
                size="lg"
                icon={<Download className="size-5" />}
                loading={enqueue.isPending}
                onClick={() => enqueue.mutate({ titleId: title.id })}
              >
                {title.kind === 'movie' ? 'Télécharger' : 'Tout télécharger'}
              </Button>
              <ButtonLink
                to={explorerUrl(title.remotePath)}
                variant="ghost"
                size="lg"
                icon={<FolderOpen className="size-5" />}
                title="Ouvrir le dossier dans l'explorateur"
              >
                Dossier source
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>

      {title.metadataStatus === 'disabled' && (
        <div className="flex items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.03] p-4 text-sm text-zinc-400">
          <Info className="mt-0.5 size-4 shrink-0 text-brand-300" />
          <p>
            Ajoutez une clé TMDB (gratuite) dans les{' '}
            <Link
              to="/parametres"
              className="font-medium text-brand-300 underline-offset-2 hover:underline"
            >
              paramètres
            </Link>{' '}
            pour afficher affiches, résumés, notes et titres des épisodes.
          </p>
        </div>
      )}

      {title.kind === 'movie' ? (
        <MovieVersions title={title} />
      ) : (
        <SeriesSeasons title={title} initialSeason={primary?.seasonKey} />
      )}
    </div>
  );
}

function TitleSkeleton() {
  return (
    <div className="flex flex-col gap-8 pt-16 md:flex-row md:items-end">
      <Skeleton className="aspect-[2/3] w-52 rounded-2xl" />
      <div className="flex flex-1 flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-4 w-5/6 max-w-xl" />
        <Skeleton className="h-12 w-72" />
      </div>
    </div>
  );
}
