import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DownloadItem } from '@lumiere/shared';
import {
  useBulkDownloadAction,
  useDownloadAction,
  useDownloads,
  useRemoveDownload,
} from '../../api/queries';
import { Poster } from '../../components/media/Poster';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { PageLoader } from '../../components/ui/Spinner';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';
import {
  episodeCode,
  formatBytes,
  formatEta,
  formatRelativeDate,
  formatSpeed,
} from '../../lib/format';
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
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

interface StatusStyle {
  label: string;
  /** Pastille : texte, fond et anneau. */
  chip: string;
  icon: ReactNode;
}

const STATUS: Record<DownloadItem['status'], StatusStyle> = {
  downloading: {
    label: 'Téléchargement',
    chip: 'bg-brand-400/15 text-brand-200 ring-brand-300/30',
    icon: (
      <span className="relative flex size-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand-300 opacity-60 motion-reduce:hidden" />
        <span className="relative size-2 rounded-full bg-brand-300" />
      </span>
    ),
  },
  queued: {
    label: 'En attente',
    chip: 'bg-white/[0.08] text-zinc-200 ring-white/10',
    icon: <Clock className="size-3" />,
  },
  paused: {
    label: 'En pause',
    chip: 'bg-amber-400/15 text-amber-200 ring-amber-300/25',
    icon: <Pause className="size-3" />,
  },
  completed: {
    label: 'Terminé',
    chip: 'bg-emerald-400/15 text-emerald-200 ring-emerald-300/25',
    icon: <CheckCircle2 className="size-3" />,
  },
  failed: {
    label: 'Échec',
    chip: 'bg-red-400/15 text-red-200 ring-red-300/25',
    icon: <AlertCircle className="size-3" />,
  },
  canceled: {
    label: 'Annulé',
    chip: 'bg-white/[0.08] text-zinc-300 ring-white/10',
    icon: <X className="size-3" />,
  },
};

const CONNECTING: StatusStyle = {
  label: 'Connexion…',
  chip: 'bg-sky-400/15 text-sky-200 ring-sky-300/25',
  icon: <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />,
};

/**
 * Carte d'un téléchargement : affiche à gauche, ambiance tirée de l'affiche (floutée), état,
 * progression et commandes regroupées dans une capsule de verre.
 */
function DownloadRow({ item }: { item: DownloadItem }) {
  const navigate = useNavigate();
  const action = useDownloadAction();
  const remove = useRemoveDownload();
  const [confirm, setConfirm] = useState(false);
  const progress = item.totalBytes ? item.downloadedBytes / item.totalBytes : null;
  const running = item.status === 'downloading';
  // Le lien est demandé et l'hôte n'a pas encore répondu : rien n'a été reçu.
  const connecting = running && item.downloadedBytes === 0 && item.speed === 0;
  const finished = item.status === 'completed' || item.status === 'canceled';
  const status = connecting ? CONNECTING : STATUS[item.status];
  const percent = progress !== null ? Math.floor(progress * 100) : null;
  const titleUrl = item.titleId ? `/titre/${item.titleId}` : null;

  return (
    <article
      className={cn(
        'relative isolate overflow-hidden rounded-[1.625rem] bg-white/[0.04] shadow-[0_22px_44px_-30px_rgb(0_0_0/0.95)] ring-1 ring-white/[0.08] ring-inset',
        // Reflet du bord supérieur, comme sur le verre.
        'before:pointer-events-none before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/25 before:to-transparent',
      )}
    >
      {item.posterUrl && (
        <div
          aria-hidden
          className="absolute inset-0 -z-10 scale-150 bg-cover bg-center opacity-35 blur-3xl saturate-150"
          style={{ backgroundImage: `url("${item.posterUrl}")` }}
        />
      )}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/20 via-ink-950/45 to-ink-950/70"
      />

      <div className="flex gap-4 p-3 sm:gap-5 sm:p-4">
        <PosterThumb item={item} to={titleUrl} compact={finished} />

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
          <div className="min-w-0">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset',
                status.chip,
              )}
            >
              {status.icon}
              {status.label}
            </span>
            <h3 className="mt-1.5 truncate text-[17px] leading-snug font-semibold text-white">
              {titleUrl ? (
                <Link
                  to={titleUrl}
                  className="outline-none hover:underline focus-visible:underline"
                >
                  {item.title}
                </Link>
              ) : (
                item.title
              )}
            </h3>
            {item.subtitle && (
              <p className="mt-0.5 truncate text-[13px] text-zinc-300">{item.subtitle}</p>
            )}
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-zinc-500"
              title={item.targetPath}
            >
              {item.fileName}
            </p>
          </div>

          {!finished && (
            <div className="flex flex-col gap-1.5">
              <ProgressBar
                label="Progression du téléchargement"
                className="h-2"
                value={progress}
                tone={
                  item.status === 'failed'
                    ? 'danger'
                    : item.status === 'downloading'
                      ? 'brand'
                      : 'muted'
                }
                indeterminate={connecting || (running && progress === null)}
                active={running && !connecting}
              />
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-zinc-300 tabular-nums">
                <span>
                  {formatBytes(item.downloadedBytes)}
                  <span className="text-zinc-500"> sur </span>
                  {formatBytes(item.totalBytes)}
                  {percent !== null && (
                    <span className="text-zinc-400 sm:hidden"> · {percent} %</span>
                  )}
                </span>
                <span className={running ? 'text-brand-300' : 'text-zinc-400'}>
                  {connecting
                    ? 'Demande du lien et connexion à l’hôte…'
                    : running && item.speed === 0
                      ? 'En attente de données…'
                      : running
                        ? [
                            formatSpeed(item.speed),
                            item.eta !== null && `${formatEta(item.eta)} restantes`,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : item.status === 'queued'
                          ? 'En attente d’une place libre'
                          : item.status === 'paused'
                            ? 'Reprise là où il s’est arrêté'
                            : null}
                </span>
              </div>
            </div>
          )}

          {item.error && (
            <p className="flex items-start gap-1.5 rounded-[0.875rem] bg-red-500/10 px-3 py-2 text-xs text-red-200 ring-1 ring-red-300/20 ring-inset">
              <AlertCircle className="mt-px size-3.5 shrink-0" />
              {item.error}
            </p>
          )}
          {item.status === 'completed' && (
            <p className="text-xs text-zinc-400">
              {formatBytes(item.totalBytes)} · terminé {formatRelativeDate(item.completedAt)}
            </p>
          )}

          {/* Commandes (sous le texte sur mobile). */}
          <DownloadControls
            item={item}
            className="self-start sm:hidden"
            onPlay={(id) => navigate(playerUrl({ type: 'library', id }))}
            onAction={(name) => action.mutate({ id: item.id, action: name })}
            onRemove={() => setConfirm(true)}
          />
        </div>

        <div
          className={cn(
            'hidden shrink-0 flex-col items-end gap-3 sm:flex',
            finished || percent === null ? 'justify-center' : 'justify-between',
          )}
        >
          {!finished && percent !== null && (
            <p
              aria-hidden
              className={cn(
                'text-3xl leading-none font-semibold tracking-tight tabular-nums',
                running ? 'text-white' : 'text-zinc-400',
              )}
            >
              {percent}
              <span className="ml-0.5 text-base font-medium text-zinc-400">%</span>
            </p>
          )}
          <DownloadControls
            item={item}
            onPlay={(id) => navigate(playerUrl({ type: 'library', id }))}
            onAction={(name) => action.mutate({ id: item.id, action: name })}
            onRemove={() => setConfirm(true)}
          />
        </div>
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

/** Affiche du titre (lien vers sa fiche), avec le code de l'épisode. */
function PosterThumb({
  item,
  to,
  compact,
}: {
  item: DownloadItem;
  to: string | null;
  compact: boolean;
}) {
  const code = item.kind === 'episode' ? episodeCode(item.season, item.episode) : null;
  const content = (
    <>
      <Poster
        url={item.posterUrl}
        title={item.title}
        kind={item.kind === 'episode' ? 'series' : 'movie'}
        className="[&_p]:text-[10px] [&_svg]:size-3.5"
      />
      {code && (
        <span className="absolute inset-x-1 bottom-1 rounded-full bg-black/60 py-0.5 text-center text-[10px] font-semibold text-white backdrop-blur-sm">
          {code}
        </span>
      )}
    </>
  );
  const className = cn(
    'relative shrink-0 self-start overflow-hidden rounded-[1rem] shadow-[0_12px_24px_-12px_rgb(0_0_0/0.95)] ring-1 ring-white/10',
    compact ? 'w-12 sm:w-14' : 'w-16 sm:w-20',
  );
  return to ? (
    <Link to={to} className={className} aria-label={`Fiche : ${item.title}`}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

/** Commandes d'un téléchargement, regroupées dans une capsule de verre. */
function DownloadControls({
  item,
  className,
  onPlay,
  onAction,
  onRemove,
}: {
  item: DownloadItem;
  className?: string;
  onPlay: (libraryItemId: number) => void;
  onAction: (action: 'pause' | 'resume' | 'cancel') => void;
  onRemove: () => void;
}) {
  const running = item.status === 'downloading' || item.status === 'queued';
  const resumable =
    item.status === 'paused' || item.status === 'failed' || item.status === 'canceled';
  const open = item.status !== 'completed' && item.status !== 'canceled';
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      {item.status === 'completed' && item.libraryItemId !== null && (
        <Button
          variant="primary"
          size="icon"
          aria-label="Lire"
          title="Lire"
          onClick={() => onPlay(item.libraryItemId as number)}
        >
          <Play className="size-4 fill-current" />
        </Button>
      )}
      <Glass
        lens={false}
        role="group"
        aria-label="Commandes du téléchargement"
        className="flex items-center gap-0.5 rounded-full p-1"
      >
        {running && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Mettre en pause"
            title="Mettre en pause"
            onClick={() => onAction('pause')}
          >
            <Pause className="size-4" />
          </Button>
        )}
        {resumable && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={item.status === 'paused' ? 'Reprendre' : 'Réessayer'}
            title={item.status === 'paused' ? 'Reprendre' : 'Réessayer'}
            onClick={() => onAction('resume')}
          >
            {item.status === 'paused' ? (
              <Play className="size-4" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </Button>
        )}
        {open && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Annuler"
            title="Annuler"
            onClick={() => onAction('cancel')}
          >
            <X className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Retirer de la liste"
          title="Retirer de la liste"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </Glass>
    </div>
  );
}
