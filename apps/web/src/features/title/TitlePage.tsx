import {
  AlertTriangle,
  Clock,
  Download,
  FolderOpen,
  Info,
  Play,
  SearchX,
  Star,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import type { MediaRef, TitleDetails } from '@lumiere/shared';
import { useEnqueueTitle, useTitle } from '../../api/queries';
import { Backdrop, Poster } from '../../components/media/Poster';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { useAmbient } from '../../design/ambient/ambient';
import { formatClock, formatDuration, formatRating, episodeCode } from '../../lib/format';
import { explorerUrl, playerUrl } from '../../lib/routes';
import { isAddonPath, mediaRefFor } from './file-utils';
import { MovieVersions } from './MovieVersions';
import { SeriesSeasons } from './SeriesSeasons';

/** Épisode dont le fichier sera choisi à la lecture (extension Stremio). */
function onDemand(
  title: TitleDetails,
  episode: { season: number | null; episode: number | null },
): MediaRef | null {
  if (!title.streamsOnDemand || episode.season === null || episode.episode === null) return null;
  return { type: 'episode', titleId: title.id, season: episode.season, episode: episode.episode };
}

/** Média à lancer avec le bouton principal : film téléchargé ou 1080p, prochain épisode non vu. */
function primaryAction(
  title: TitleDetails,
): { media: MediaRef; label: string; seasonKey?: string } | null {
  if (title.kind === 'movie') {
    const file =
      title.files.find((item) => item.availability.libraryItemId !== null) ??
      title.files.find((item) => item.release.resolution === '1080p') ??
      title.files[0];
    if (!file) return null;
    const watch = file.availability.watch;
    const resume = watch && !watch.completed && watch.position > 30;
    return {
      media: mediaRefFor(file),
      label: resume ? `Reprendre à ${formatClock(watch.position)}` : 'Lecture',
    };
  }
  const seasons = [...title.seasons].sort(
    (a, b) => (a.number === 0 ? 1 : 0) - (b.number === 0 ? 1 : 0),
  );
  for (const season of seasons) {
    for (const episode of season.episodes) {
      const file =
        episode.files.find((item) => item.availability.libraryItemId !== null) ?? episode.files[0];
      if (file?.availability.watch?.completed) continue;
      const code = episodeCode(episode.season, episode.episode) ?? episode.title;
      const media = file ? mediaRefFor(file) : onDemand(title, episode);
      if (!media) continue;
      const watch = file?.availability.watch;
      const resume = watch && watch.position > 30;
      return {
        media,
        label: resume ? `Reprendre ${code}` : `Lecture ${code}`,
        seasonKey: season.key,
      };
    }
  }
  const first = title.seasons[0]?.episodes[0];
  const media = first?.files[0] ? mediaRefFor(first.files[0]) : first && onDemand(title, first);
  return media ? { media, label: 'Revoir depuis le début' } : null;
}

export function TitlePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useTitle(Number(id));
  const enqueue = useEnqueueTitle();
  useAmbient(query.data?.backdropUrl ?? query.data?.posterUrl, query.data?.title);

  if (query.isPending) return <TitleSkeleton />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const title = query.data;
  const primary = primaryAction(title);
  const viaAddon = isAddonPath(title.remotePath);
  const rating = formatRating(title.rating);
  const episodeCount = title.seasons.reduce((total, season) => total + season.episodes.length, 0);

  return (
    <div className="flex flex-col gap-10">
      <section className="bleed bleed-top relative overflow-hidden">
        <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,#000_50%,transparent)]">
          <Backdrop url={title.backdropUrl} seed={title.title} className="opacity-75" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgb(0_0_0/0.3),rgb(0_0_0/0.78)_var(--inset-left),rgb(0_0_0/0.4)_65%,rgb(0_0_0/0.1))]" />
          <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/50 to-transparent" />
        </div>

        <div className="relative flex flex-col gap-6 pt-[calc(var(--inset-top)+0.5rem)] pb-4 md:flex-row md:items-end md:gap-10 md:pt-[calc(var(--inset-top)+3rem)]">
          <div className="media-frame w-40 shrink-0 shadow-[0_30px_60px_-24px_rgb(0_0_0/0.9)] sm:w-52 lg:w-60">
            <Poster
              url={title.posterUrl}
              title={title.title}
              year={title.year}
              kind={title.kind}
              eager
            />
          </div>
          <div className="text-shadow-legible flex min-w-0 flex-1 animate-fade-in flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
              <Badge tone="neutral">{title.kind === 'movie' ? 'Film' : 'Série'}</Badge>
              {title.year && <span>{title.year}</span>}
              {rating && (
                <span className="flex items-center gap-1">
                  <Star className="size-4 fill-brand-400 text-brand-400" />
                  <span className="font-semibold text-white">{rating}</span>
                  <span className="text-zinc-400">/10</span>
                </span>
              )}
              {title.runtime && (
                <span className="flex items-center gap-1 text-zinc-300">
                  <Clock className="size-3.5" />
                  {title.kind === 'movie'
                    ? formatDuration(title.runtime * 60)
                    : `${title.runtime} min / épisode`}
                </span>
              )}
              {title.kind === 'series' && (
                <span className="text-zinc-300">
                  {title.seasons.length} saison(s) · {episodeCount} épisode(s)
                </span>
              )}
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-balance text-white sm:text-5xl">
              {title.title}
            </h1>
            {title.originalTitle && title.originalTitle !== title.title && (
              <p className="-mt-2 text-sm text-zinc-300">Titre original : {title.originalTitle}</p>
            )}
            {title.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {title.genres.map((genre) => (
                  <span
                    key={genre}
                    className="fill rounded-full px-3 py-1 text-xs font-medium text-zinc-100"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}
            {title.tagline && (
              <p className="text-lg font-medium text-brand-200 italic">« {title.tagline} »</p>
            )}
            {title.overview && (
              <p className="max-w-3xl leading-relaxed text-zinc-200">{title.overview}</p>
            )}
            {/* Rien à lire ni à télécharger quand le titre est introuvable sur la source. */}
            {title.sourceStatus !== 'missing' && (
              <div className="mt-1 flex flex-wrap gap-3">
                {primary && (
                  <Button
                    variant="primary"
                    size="lg"
                    icon={<Play className="size-5 fill-current" />}
                    onClick={() => navigate(playerUrl(primary.media))}
                  >
                    {primary.label}
                  </Button>
                )}
                <Button
                  variant="glass"
                  size="lg"
                  icon={<Download className="size-5" />}
                  loading={enqueue.isPending}
                  onClick={() => enqueue.mutate({ titleId: title.id })}
                  title={
                    title.streamsOnDemand
                      ? 'Chaque épisode est demandé à l’extension Stremio, un par un'
                      : undefined
                  }
                >
                  {title.kind === 'movie' ? 'Télécharger' : 'Tout télécharger'}
                </Button>
                {/* Les fichiers d'une extension n'ont pas de dossier à parcourir. */}
                {!viaAddon && (
                  <ButtonLink
                    to={explorerUrl(title.remotePath)}
                    variant="glass"
                    size="icon-lg"
                    title="Ouvrir le dossier source dans l'explorateur"
                    aria-label="Dossier source"
                  >
                    <FolderOpen className="size-5" />
                  </ButtonLink>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {title.metadataStatus === 'disabled' && (
        <div className="fill flex items-start gap-3 rounded-card p-4 text-sm text-zinc-300">
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

      {title.sourceNotice && (
        <div
          role="status"
          className="fill flex items-start gap-3 rounded-card p-4 text-sm text-zinc-200"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
          <p>
            <span className="font-semibold">Extension Stremio : </span>
            {title.sourceNotice}
          </p>
        </div>
      )}

      {title.sourceStatus === 'missing' ? (
        <SourceMissing title={title} viaAddon={viaAddon} />
      ) : title.kind === 'movie' ? (
        <MovieVersions title={title} />
      ) : (
        <SeriesSeasons title={title} initialSeason={primary?.seasonKey} />
      )}
    </div>
  );
}

/** Titre venu de TMDB que la source ne propose pas (sous les noms de dossier essayés). */
function SourceMissing({ title, viaAddon }: { title: TitleDetails; viaAddon: boolean }) {
  if (viaAddon) {
    return (
      <EmptyState
        icon={<SearchX />}
        title="Aucun fichier proposé"
        description={`L’extension Stremio ne propose aucun fichier pour ${title.kind === 'movie' ? 'ce film' : 'cette série'} pour l’instant. Réessayez plus tard : son offre évolue.`}
      />
    );
  }
  return (
    <EmptyState
      icon={<SearchX />}
      title="Introuvable sur la source"
      description={
        <>
          <p>
            {title.kind === 'movie' ? 'Ce film' : 'Cette série'} n’a pas été trouvé sur la source.
            Il n’y est peut-être pas, ou son dossier porte un autre nom. Nouvel essai automatique
            dans 24 h.
          </p>
          {title.sourceTried.length > 0 && (
            <p className="mt-3 text-xs text-zinc-500">
              Dossiers essayés :{' '}
              {title.sourceTried.map((folder, index) => (
                <span key={folder}>
                  {index > 0 && ', '}
                  <span className="font-mono text-zinc-400">{folder}</span>
                </span>
              ))}
            </p>
          )}
        </>
      }
    />
  );
}

function TitleSkeleton() {
  return (
    <div className="flex flex-col gap-8 pt-16 md:flex-row md:items-end">
      <Skeleton className="aspect-[2/3] w-52 rounded-tile" />
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
