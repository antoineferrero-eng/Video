import { ChevronDown, Download, Loader2, Play, Tv } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type {
  EpisodeEntry,
  MediaRef,
  RemoteFile,
  SeasonEntry,
  TitleDetails,
} from '@lumiere/shared';
import { errorMessage } from '../../api/client';
import { useEnqueueTitle, useEpisodeFiles } from '../../api/queries';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/States';
import { Tabs } from '../../components/ui/Tabs';
import { gradientFor } from '../../lib/artwork';
import { cn } from '../../lib/cn';
import { formatBytes, formatDate, pad2, plural } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { DownloadState, PlayButton, WatchProgress, WatchedToggle } from './FileActions';
import { mediaRefFor } from './file-utils';

export function SeriesSeasons({
  title,
  initialSeason,
}: {
  title: TitleDetails;
  initialSeason?: string;
}) {
  const [selected, setSelected] = useState(initialSeason ?? title.seasons[0]?.key ?? '');
  const enqueue = useEnqueueTitle();
  const season = title.seasons.find((item) => item.key === selected) ?? title.seasons[0];

  if (!season) {
    return (
      <EmptyState
        icon={<Tv />}
        title="Aucun épisode trouvé"
        description="TMDB ne liste encore aucun épisode diffusé pour cette série."
      />
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <Tabs
        label="Saisons"
        items={title.seasons.map((item) => ({
          value: item.key,
          label: item.name,
          count: item.episodes.length,
        }))}
        value={season.key}
        onChange={setSelected}
      />
      <SeasonHeader
        season={season}
        onDownload={() => enqueue.mutate({ titleId: title.id, season: season.number })}
        downloading={enqueue.isPending}
      />
      <div className="flex flex-col gap-2">
        {season.episodes.map((episode) => (
          <EpisodeRow
            key={episode.key}
            episode={episode}
            titleId={title.id}
            seriesTitle={title.title}
          />
        ))}
      </div>
    </section>
  );
}

function SeasonHeader({
  season,
  onDownload,
  downloading,
}: {
  season: SeasonEntry;
  onDownload: () => void;
  downloading: boolean;
}) {
  const size = season.episodes.reduce((total, episode) => total + (episode.files[0]?.size ?? 0), 0);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-xl font-bold tracking-tight">{season.name}</h2>
        <p className="text-sm text-zinc-400">
          {plural(season.episodes.length, 'épisode')}
          {size > 0 && ` · environ ${formatBytes(size)}`}
        </p>
        {season.overview && (
          <p className="mt-2 max-w-3xl text-sm text-zinc-300">{season.overview}</p>
        )}
        <p className="mt-2 max-w-3xl text-xs text-zinc-400">
          Les liens d’un épisode sont demandés aux extensions Stremio au moment de le lire ou de le
          télécharger (leur réserve de liens peut être limitée).
        </p>
      </div>
      {season.episodes.length > 0 && (
        <Button
          variant="glass"
          icon={<Download className="size-4" />}
          onClick={onDownload}
          loading={downloading}
        >
          Télécharger la saison
        </Button>
      )}
    </div>
  );
}

/**
 * Progression du visionnage collée au bas de la vignette. Le positionnement est porté par un
 * conteneur : sur la barre elle-même, `absolute` serait supplanté par son `relative`.
 */
function StillProgress({ file }: { file: RemoteFile }) {
  return (
    <div className="absolute inset-x-0 bottom-0">
      <WatchProgress file={file} className="rounded-none" />
    </div>
  );
}

/** Vignette d'un épisode (image TMDB, sinon dégradé et numéro). */
function EpisodeStill({
  episode,
  seriesTitle,
  onPlay,
  children,
}: {
  episode: EpisodeEntry;
  seriesTitle: string;
  onPlay: () => void;
  children?: ReactNode;
}) {
  const [stillFailed, setStillFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onPlay}
      className="relative aspect-video w-full shrink-0 overflow-hidden rounded-[0.75rem] shadow-[0_10px_24px_-14px_rgb(0_0_0/0.9)] sm:w-48"
      aria-label={`Lire ${episode.title}`}
    >
      <div
        className="absolute inset-0"
        style={{ background: gradientFor(`${seriesTitle}-${episode.key}`) }}
      />
      {episode.stillUrl && !stillFailed && (
        <img
          src={episode.stillUrl}
          alt=""
          loading="lazy"
          onError={() => setStillFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {(!episode.stillUrl || stillFailed) && episode.episode !== null && (
        <span className="absolute inset-0 flex items-center justify-center text-3xl font-black text-white/25">
          {pad2(episode.episode)}
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100">
        <span className="glass glass-clear flex size-12 items-center justify-center rounded-full">
          <Play className="ml-0.5 size-5 fill-white text-white" />
        </span>
      </span>
      {children}
    </button>
  );
}

/**
 * Épisode : lecture et téléchargement sans fichier choisi d'avance (la version préférée est
 * demandée aux extensions au moment voulu) ; la liste des versions n'est demandée qu'à
 * l'ouverture.
 */
function EpisodeRow({
  episode,
  titleId,
  seriesTitle,
}: {
  episode: EpisodeEntry;
  titleId: number;
  seriesTitle: string;
}) {
  const navigate = useNavigate();
  const enqueue = useEnqueueTitle();
  const [expanded, setExpanded] = useState(false);
  if (episode.season === null || episode.episode === null) return null;
  const { season, episode: number } = episode;
  // Copie déjà connue : téléchargée, en cours de téléchargement, ou regardée en streaming.
  const known =
    episode.files.find((item) => item.availability.libraryItemId !== null) ?? episode.files[0];
  const media: MediaRef = known
    ? mediaRefFor(known)
    : { type: 'episode', titleId, season, episode: number };
  const watched = known?.availability.watch?.completed ?? false;

  return (
    <article className="fill group flex flex-col gap-3 rounded-card p-2.5 sm:flex-row sm:items-center sm:gap-4">
      <EpisodeStill
        episode={episode}
        seriesTitle={seriesTitle}
        onPlay={() => navigate(playerUrl(media))}
      >
        {known && <StillProgress file={known} />}
      </EpisodeStill>

      <div className="min-w-0 flex-1 px-1 sm:px-0">
        <h3 className={cn('font-semibold', watched ? 'text-zinc-400' : 'text-white')}>
          <span className="text-zinc-400">{number}. </span>
          {episode.title}
        </h3>
        <p className="mt-0.5 text-xs text-zinc-400">
          {[
            episode.airDate && formatDate(episode.airDate),
            episode.runtime && `${episode.runtime} min`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {episode.overview && (
          <p className="mt-1.5 line-clamp-2 text-sm text-zinc-300">{episode.overview}</p>
        )}
        {known && (
          <div className="mt-2">
            <ReleaseBadges release={known.release} compact />
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-200"
        >
          Choisir une version
          <ChevronDown className={cn('size-3.5 transition', expanded && 'rotate-180')} />
        </button>
        {expanded && <EpisodeVersions titleId={titleId} season={season} episode={number} />}
      </div>

      <div className="flex items-center gap-2 self-end pr-1.5 pb-1 sm:self-center sm:pb-0">
        {known && <WatchedToggle file={known} />}
        {known ? (
          <DownloadState file={known} titleId={titleId} />
        ) : (
          <Button
            size="sm"
            icon={<Download className="size-4" />}
            loading={enqueue.isPending}
            onClick={() => enqueue.mutate({ titleId, season, episode: number })}
            title="Télécharger la version préférée (demandée aux extensions)"
          >
            Télécharger
          </Button>
        )}
        {known ? (
          <PlayButton file={known} />
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="size-4 fill-current" />}
            onClick={() => navigate(playerUrl(media))}
            title="Regarder (la version préférée est demandée aux extensions)"
          >
            Lecture
          </Button>
        )}
      </div>
    </article>
  );
}

/** Versions d'un épisode proposées par les extensions (une demande de liens à l'ouverture). */
function EpisodeVersions({
  titleId,
  season,
  episode,
}: {
  titleId: number;
  season: number;
  episode: number;
}) {
  const query = useEpisodeFiles(titleId, season, episode, true);
  if (query.isPending) {
    return (
      <p className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <Loader2 className="size-3.5 animate-spin" />
        Demande des liens aux extensions…
      </p>
    );
  }
  if (query.isError) {
    return <p className="mt-2 text-xs text-red-300">{errorMessage(query.error)}</p>;
  }
  const { files, notice } = query.data;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {notice && <p className="text-xs text-amber-200">{notice}</p>}
      {files.length === 0 && !notice && (
        <p className="text-xs text-zinc-400">
          Aucune extension ne propose de version de cet épisode.
        </p>
      )}
      {files.map((version) => (
        <div
          key={version.path}
          className="flex flex-wrap items-center gap-2 rounded-[0.875rem] bg-white/[0.05] p-2"
        >
          <div className="min-w-0 flex-1">
            <span
              className="block truncate font-mono text-[11px] text-zinc-300"
              title={version.name}
            >
              {version.name}
            </span>
            {version.label && (
              <span className="block truncate text-[11px] text-zinc-500" title={version.label}>
                {version.label}
              </span>
            )}
          </div>
          <span className="text-xs text-zinc-400">{formatBytes(version.size)}</span>
          <DownloadState file={version} titleId={titleId} compact />
          <PlayButton file={version} label={null} />
        </div>
      ))}
    </div>
  );
}
