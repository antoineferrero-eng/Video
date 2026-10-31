import { Loader2 } from 'lucide-react';
import { errorMessage } from '../../api/client';
import { useEpisodeFiles } from '../../api/queries';
import { formatBytes } from '../../lib/format';
import { DownloadState, PlayButton } from './FileActions';

/** Versions d'un épisode proposées par les extensions (une demande de liens à l'ouverture). */
export function EpisodeVersions({
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
