import { HardDrive } from 'lucide-react';
import type { TitleDetails } from '@lumiere/shared';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { formatBytes } from '../../lib/format';
import { DownloadCard } from './DownloadCard';
import { DownloadState, PlayButton, WatchProgress, WatchedToggle } from './FileActions';

/** Film : ses copies sur le disque (ou en cours de téléchargement), puis « Télécharger ». */
export function MovieVersions({ title }: { title: TitleDetails }) {
  const copies = title.files;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <HardDrive className="size-5 text-zinc-400" />
          Sur le disque
        </h2>
        {copies.length === 0 ? (
          <p className="text-sm text-zinc-400">
            Ce film n’est pas encore sur le disque : choisissez une source ci-dessous.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {copies.map((file) => (
              <div
                key={file.path}
                className="fill flex flex-col gap-3 rounded-card p-4 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <ReleaseBadges release={file.release} />
                  <p className="mt-2 truncate font-mono text-xs text-zinc-300" title={file.name}>
                    {file.name}
                  </p>
                  {file.size !== null && (
                    <p className="mt-1 text-xs text-zinc-400">{formatBytes(file.size)}</p>
                  )}
                  <WatchProgress file={file} className="mt-2 max-w-xs" />
                </div>
                <div className="flex items-center gap-2">
                  <WatchedToggle file={file} />
                  <DownloadState file={file} titleId={title.id} />
                  <PlayButton file={file} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <DownloadCard title={title} />
    </div>
  );
}
