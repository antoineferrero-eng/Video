import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DownloadItem } from '@lumiere/shared';
import {
  useBulkDownloadAction,
  useDownloadAction,
  useDownloads,
  useRemoveDownload,
} from '../../api/queries';
import { Poster } from '../../components/media/Poster';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { PageLoader } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Glass } from '../../design/glass/Glass';
import { formatBytes, formatEta, formatRelativeDate, formatSpeed } from '../../lib/format';
import { playerUrl } from '../../lib/routes';

export function DownloadsPage() {
  const downloads = useDownloads();
  const bulk = useBulkDownloadAction();

  if (downloads.isPending) return <PageLoader />;
  if (downloads.isError)
    return <ErrorState error={downloads.error} onRetry={() => void downloads.refetch()} />;

  const { items, stats } = downloads.data;
  const active = items.filter((item) => ['downloading', 'queued', 'paused'].includes(item.status));
  const failed = items.filter((item) => item.status === 'failed');
  const finished = items.filter(
    (item) => item.status === 'completed' || item.status === 'canceled',
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="large-title">Téléchargements</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <Stat label="Débit" value={formatSpeed(stats.speed)} highlight={stats.speed > 0} />
            <Stat label="En cours" value={String(stats.active)} />
            <Stat label="En attente" value={String(stats.queued)} />
            {stats.paused > 0 && <Stat label="En pause" value={String(stats.paused)} />}
            {stats.failed > 0 && <Stat label="Échecs" value={String(stats.failed)} />}
          </div>
        </div>
        {/* Actions groupées dans une même capsule de verre (HIG : regrouper par fonction). */}
        <Glass
          role="toolbar"
          aria-label="Actions sur tous les téléchargements"
          className="flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-full p-1 lg:self-auto"
        >
          <Button
            variant="ghost"
            icon={<Pause className="size-4" />}
            onClick={() => bulk.mutate('pause-all')}
            disabled={stats.active + stats.queued === 0}

            aria-label="Tout mettre en pause"
            title="Tout mettre en pause"
          >
            <span className="hidden sm:inline">Tout mettre en pause</span>
          </Button>
          <Button
            variant="ghost"
            icon={<Play className="size-4" />}
            onClick={() => bulk.mutate('resume-all')}
            disabled={stats.paused + stats.failed === 0}

            aria-label="Tout reprendre"
            title="Tout reprendre"
          >
            <span className="hidden sm:inline">Tout reprendre</span>
          </Button>
          <Button
            variant="ghost"
            icon={<Trash2 className="size-4" />}
            onClick={() => bulk.mutate('clear')}
            disabled={finished.length === 0}

            aria-label="Effacer l'historique"
            title="Effacer l'historique"
          >
            <span className="hidden sm:inline">Effacer l'historique</span>
          </Button>
        </Glass>
      </header>

      {items.length === 0 && (
        <EmptyState
          icon={<Download />}
          title="Aucun téléchargement"
          description="Lancez un téléchargement depuis la fiche d'un film ou d'une série : il apparaîtra ici avec sa progression en temps réel."
        />
      )}

      {active.length > 0 && (
        <DownloadSection title="En cours">
          {active.map((item) => (
            <DownloadRow key={item.id} item={item} />
          ))}
        </DownloadSection>
      )}
      {failed.length > 0 && (
        <DownloadSection title="Échecs">
          {failed.map((item) => (
            <DownloadRow key={item.id} item={item} />
          ))}
        </DownloadSection>
      )}
      {finished.length > 0 && (
        <DownloadSection title="Historique">
          {finished.map((item) => (
            <DownloadRow key={item.id} item={item} />
          ))}
        </DownloadSection>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="fill rounded-[1rem] px-4 py-2">
      <p className="text-[11px] font-medium text-zinc-400">{label}</p>
      <p
        className={
          highlight
            ? 'text-sm font-semibold text-brand-300 tabular-nums'
            : 'text-sm font-semibold text-white tabular-nums'
        }
      >
        {value}
      </p>
    </div>
  );
}

function DownloadSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold tracking-tight text-white">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

const STATUS: Record<
  DownloadItem['status'],
  { label: string; tone: 'brand' | 'neutral' | 'warning' | 'success' | 'danger' }
> = {
  downloading: { label: 'Téléchargement', tone: 'brand' },
  queued: { label: 'En attente', tone: 'neutral' },
  paused: { label: 'En pause', tone: 'warning' },
  completed: { label: 'Terminé', tone: 'success' },
  failed: { label: 'Échec', tone: 'danger' },
  canceled: { label: 'Annulé', tone: 'neutral' },
};

function DownloadRow({ item }: { item: DownloadItem }) {
  const navigate = useNavigate();
  const action = useDownloadAction();
  const remove = useRemoveDownload();
  const [confirm, setConfirm] = useState(false);
  const progress = item.totalBytes ? item.downloadedBytes / item.totalBytes : null;
  const status = STATUS[item.status];
  const running = item.status === 'downloading';

  return (
    <article className="fill flex items-center gap-4 rounded-card p-3 sm:p-3.5">
      <Link
        to={item.titleId ? `/titre/${item.titleId}` : '#'}
        className="hidden w-12 shrink-0 overflow-hidden rounded-[0.625rem] shadow-[0_8px_18px_-10px_rgb(0_0_0/0.9)] sm:block"
        aria-label={item.title}
      >
        <Poster
          url={item.posterUrl}
          title={item.title}
          kind={item.kind === 'episode' ? 'series' : 'movie'}
          className="[&_p]:text-[7px] [&_svg]:hidden"
        />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-semibold text-white">{item.title}</h3>
          <Badge
            tone={status.tone}
            icon={item.status === 'completed' ? <CheckCircle2 className="size-3" /> : undefined}
          >
            {status.label}
          </Badge>
        </div>
        {item.subtitle && <p className="mt-0.5 text-xs text-zinc-300">{item.subtitle}</p>}
        <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400" title={item.targetPath}>
          {item.fileName}
        </p>
        {item.status !== 'completed' && item.status !== 'canceled' && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            <ProgressBar
              label="Progression du téléchargement"
              value={progress}
              tone={
                item.status === 'failed' ? 'danger' : item.status === 'paused' ? 'muted' : 'brand'
              }
              indeterminate={running && progress === null}
            />
            <div className="flex flex-wrap justify-between gap-x-4 text-xs text-zinc-300 tabular-nums">
              <span>
                {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}
                {progress !== null && ` · ${Math.floor(progress * 100)} %`}
              </span>
              {running && (
                <span className="text-brand-300">
                  {formatSpeed(item.speed)}
                  {item.eta !== null && ` · ${formatEta(item.eta)} restantes`}
                </span>
              )}
            </div>
          </div>
        )}
        {item.error && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-red-300">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {item.error}
          </p>
        )}
        {item.status === 'completed' && (
          <p className="mt-1 text-xs text-zinc-400">
            {formatBytes(item.totalBytes)} · terminé {formatRelativeDate(item.completedAt)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.status === 'completed' && item.libraryItemId !== null && (
          <Button
            variant="primary"
            size="icon-sm"
            title="Lire"
            onClick={() =>
              navigate(playerUrl({ type: 'library', id: item.libraryItemId as number }))
            }
          >
            <Play className="size-4 fill-current" />
          </Button>
        )}
        {(running || item.status === 'queued') && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Mettre en pause"
            onClick={() => action.mutate({ id: item.id, action: 'pause' })}
          >
            <Pause className="size-4" />
          </Button>
        )}
        {(item.status === 'paused' || item.status === 'failed' || item.status === 'canceled') && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={item.status === 'paused' ? 'Reprendre' : 'Réessayer'}
            onClick={() => action.mutate({ id: item.id, action: 'resume' })}
          >
            {item.status === 'paused' ? (
              <Play className="size-4" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </Button>
        )}
        {item.status !== 'completed' && item.status !== 'canceled' && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Annuler"
            onClick={() => action.mutate({ id: item.id, action: 'cancel' })}
          >
            <X className="size-4" />
          </Button>
        )}
        {item.titleId && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Voir la fiche"
            onClick={() => navigate(`/titre/${item.titleId}`)}
          >
            <FolderOpen className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="Retirer de la liste"
          onClick={() => setConfirm(true)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Retirer ce téléchargement ?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Annuler
            </Button>
            {item.status === 'completed' && (
              <Button
                variant="danger"
                onClick={() => {
                  remove.mutate({ id: item.id, deleteFile: true });
                  setConfirm(false);
                }}
              >
                Supprimer aussi le fichier
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => {
                remove.mutate({ id: item.id, deleteFile: false });
                setConfirm(false);
              }}
            >
              Retirer de la liste
            </Button>
          </>
        }
      >
        {item.status === 'completed'
          ? 'Le fichier reste dans votre bibliothèque, sauf si vous choisissez de le supprimer.'
          : 'Le téléchargement est interrompu et le fichier partiel supprimé.'}
      </Dialog>
    </article>
  );
}
