import { HardDrive, Play, Tv } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { EpisodeEntry, RemoteFile, SeasonEntry, TitleDetails } from '@lumiere/shared';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { EmptyState } from '../../components/ui/States';
import { Tabs } from '../../components/ui/Tabs';
import { gradientFor } from '../../lib/artwork';
import { cn } from '../../lib/cn';
import { formatDate, pad2 } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { DownloadCard } from './DownloadCard';
import { DownloadState, PlayButton, WatchProgress, WatchedToggle } from './FileActions';
import { mediaRefFor } from './file-utils';

/** Copie d'un épisode à présenter : celle de la bibliothèque, sinon la première connue. */
function copyOf(episode: EpisodeEntry): RemoteFile | undefined {
  return episode.files.find((item) => item.availability.libraryItemId !== null) ?? episode.files[0];
}

/**
 * Saisons d'une série (d'après TMDB) : pour chacune, le bloc « Télécharger la saison », puis
 * ses épisodes et ce qui est déjà sur le disque.
 */
export function SeriesSeasons({
  title,
  initialSeason,
}: {
  title: TitleDetails;
  initialSeason?: string;
}) {
  const [selected, setSelected] = useState(initialSeason ?? title.seasons[0]?.key ?? '');
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
      <SeasonHeader season={season} />
      <DownloadCard title={title} season={season} />
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

function SeasonHeader({ season }: { season: SeasonEntry }) {
  const onDisk = season.episodes.filter(
    (episode) => copyOf(episode)?.availability.libraryItemId != null,
  ).length;
  const total = season.episodes.length;
  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">{season.name}</h2>
      <p
        className={cn(
          'mt-0.5 flex items-center gap-1.5 text-sm',
          onDisk === total && total > 0 ? 'text-emerald-300' : 'text-zinc-400',
        )}
      >
        <HardDrive className="size-4" />
        {onDisk === 0
          ? `Aucun des ${total} épisodes sur le disque`
          : onDisk === total
            ? 'Saison complète sur le disque'
            : `${onDisk} épisode${onDisk > 1 ? 's' : ''} sur ${total} sur le disque`}
      </p>
      {season.overview && <p className="mt-2 max-w-3xl text-sm text-zinc-300">{season.overview}</p>}
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
  onPlay?: () => void;
  children?: ReactNode;
}) {
  const [stillFailed, setStillFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={!onPlay}
      className="relative aspect-video w-full shrink-0 overflow-hidden rounded-[0.75rem] shadow-[0_10px_24px_-14px_rgb(0_0_0/0.9)] sm:w-48"
      aria-label={onPlay ? `Lire ${episode.title}` : episode.title}
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
          className={cn('absolute inset-0 size-full object-cover', !onPlay && 'opacity-60')}
        />
      )}
      {(!episode.stillUrl || stillFailed) && episode.episode !== null && (
        <span className="absolute inset-0 flex items-center justify-center text-3xl font-black text-white/25">
          {pad2(episode.episode)}
        </span>
      )}
      {onPlay && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100">
          <span className="glass glass-clear flex size-12 items-center justify-center rounded-full">
            <Play className="ml-0.5 size-5 fill-white text-white" />
          </span>
        </span>
      )}
      {children}
    </button>
  );
}

/** Épisode : ce qui est sur le disque (ou en cours de téléchargement) et sa lecture. */
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
  if (episode.season === null || episode.episode === null) return null;
  const known = copyOf(episode);
  const watched = known?.availability.watch?.completed ?? false;

  return (
    <article className="fill group flex flex-col gap-3 rounded-card p-2.5 sm:flex-row sm:items-center sm:gap-4">
      <EpisodeStill
        episode={episode}
        seriesTitle={seriesTitle}
        onPlay={known ? () => navigate(playerUrl(mediaRefFor(known))) : undefined}
      >
        {known && <StillProgress file={known} />}
      </EpisodeStill>

      <div className="min-w-0 flex-1 px-1 sm:px-0">
        <h3 className={cn('font-semibold', watched ? 'text-zinc-400' : 'text-white')}>
          <span className="text-zinc-400">{episode.episode}. </span>
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
      </div>

      <div className="flex items-center gap-2 self-end pr-1.5 pb-1 sm:self-center sm:pb-0">
        {known ? (
          <>
            <WatchedToggle file={known} />
            <DownloadState file={known} titleId={titleId} />
            <PlayButton file={known} />
          </>
        ) : (
          <span className="rounded-full px-3 py-1 text-xs text-zinc-500 ring-1 ring-white/10 ring-inset">
            Pas sur le disque
          </span>
        )}
      </div>
    </article>
  );
}
