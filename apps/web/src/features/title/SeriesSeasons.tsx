import { ChevronDown, Download, Play, Tv } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { EpisodeEntry, SeasonEntry, TitleDetails } from '@lumiere/shared';
import { useEnqueueTitle } from '../../api/queries';
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
        description="Le dossier de cette série ne contient pas encore de vidéo reconnue."
      />
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <Tabs
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
        <h2 className="text-xl font-semibold">{season.name}</h2>
        <p className="text-sm text-zinc-400">
          {plural(season.episodes.length, 'épisode')}
          {size > 0 && ` · environ ${formatBytes(size)}`}
        </p>
        {season.overview && (
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">{season.overview}</p>
        )}
      </div>
      {season.episodes.length > 0 && (
        <Button icon={<Download className="size-4" />} onClick={onDownload} loading={downloading}>
          Télécharger la saison
        </Button>
      )}
    </div>
  );
}

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
  const [expanded, setExpanded] = useState(false);
  const [stillFailed, setStillFailed] = useState(false);
  const file = episode.files[0];
  if (!file) return null;
  const watched = file.availability.watch?.completed ?? false;

  return (
    <article className="surface group flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:gap-4">
      <button
        type="button"
        onClick={() => navigate(playerUrl(mediaRefFor(file)))}
        className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl sm:w-44"
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
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
          <Play className="size-8 fill-white text-white" />
        </span>
        <WatchProgress file={file} className="absolute inset-x-0 bottom-0 rounded-none" />
      </button>

      <div className="min-w-0 flex-1">
        <h3 className={cn('font-semibold', watched ? 'text-zinc-400' : 'text-zinc-100')}>
          {episode.episode !== null && <span className="text-zinc-500">{episode.episode}. </span>}
          {episode.title}
        </h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          {[
            episode.airDate && formatDate(episode.airDate),
            episode.runtime && `${episode.runtime} min`,
            formatBytes(file.size),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {episode.overview && (
          <p className="mt-1.5 line-clamp-2 text-sm text-zinc-400">{episode.overview}</p>
        )}
        <div className="mt-2">
          <ReleaseBadges release={file.release} compact />
        </div>
        {episode.files.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-200"
          >
            {episode.files.length} versions
            <ChevronDown className={cn('size-3.5 transition', expanded && 'rotate-180')} />
          </button>
        )}
        {expanded && (
          <div className="mt-2 flex flex-col gap-2">
            {episode.files.map((version) => (
              <div
                key={version.path}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] p-2"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400"
                  title={version.name}
                >
                  {version.name}
                </span>
                <span className="text-xs text-zinc-500">{formatBytes(version.size)}</span>
                <DownloadState file={version} titleId={titleId} compact />
                <PlayButton file={version} label={null} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 self-end sm:self-center">
        <WatchedToggle file={file} />
        <DownloadState file={file} titleId={titleId} />
        <PlayButton file={file} />
      </div>
    </article>
  );
}
