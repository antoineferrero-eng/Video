import {
  Archive,
  ClipboardPaste,
  Download,
  ExternalLink,
  FileVideo,
  Loader2,
  Play,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ArchiveContent, OneFichierFileInfo } from '@lumiere/shared';
import { errorMessage } from '../../api/client';
import { useEnqueueOneFichier, useOneFichierInfo, useSettings } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import { Switch } from '../../components/ui/Switch';
import { cn } from '../../lib/cn';
import { episodeCode, formatBytes, plural } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { findOneFichierLink } from './links';
import { onOneFichierDialogRequest, type DialogRequest, type SourceSearch } from './open-dialog';
import { linkTarget, pendingLabel, type PendingTitle } from './pending-title';

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * Reçoit les liens 1fichier : Ctrl+V n'importe où dans Lumière (hors champ de saisie), page
 * du favori « Envoyer à Lumière », bouton « Lien 1fichier », ou recherche lancée sur une
 * source personnalisée (la fenêtre guide alors jusqu'au collage du lien).
 */
export function OneFichierInbox() {
  const [request, setRequest] = useState<(DialogRequest & { key: number }) | null>(null);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return;
      const link = findOneFichierLink(event.clipboardData?.getData('text') ?? '');
      if (!link) return;
      event.preventDefault();
      // Fenêtre déjà ouverte (recherche en cours) : le lien y arrive, sans la recréer.
      setRequest((current) =>
        current ? { ...current, link } : { link, search: null, key: Date.now() },
      );
    };
    document.addEventListener('paste', onPaste);
    const unsubscribe = onOneFichierDialogRequest((next) =>
      setRequest({ ...next, key: Date.now() }),
    );
    return () => {
      unsubscribe();
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  if (!request) return null;
  return (
    <OneFichierDialog
      key={request.key}
      link={request.link}
      search={request.search}
      pending={linkTarget(request.search !== null)}
      onLink={(link) => setRequest((current) => current && { ...current, link })}
      onClose={() => setRequest(null)}
    />
  );
}

function OneFichierDialog({
  link,
  search,
  pending,
  onLink,
  onClose,
}: {
  link: string;
  search: SourceSearch | null;
  pending: PendingTitle | null;
  onLink: (link: string) => void;
  onClose: () => void;
}) {
  const settings = useSettings();
  const keyMissing = settings.data?.oneFichierApiKeyConfigured === false;
  const waiting = !link;
  return (
    <Dialog
      open
      onClose={onClose}
      title={waiting && search ? `Chercher sur ${search.source}` : 'Télécharger depuis 1fichier'}
      className="w-[min(94vw,38rem)]"
    >
      {keyMissing && (
        <p className="mb-4 rounded-[0.85rem] bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
          Ajoutez d’abord la clé d’API de votre compte 1fichier premium dans les{' '}
          <Link
            to="/parametres?onglet=sources#1fichier"
            onClick={onClose}
            className="font-medium underline underline-offset-2"
          >
            paramètres
          </Link>
          .
        </p>
      )}
      {waiting ? (
        <WaitForLink search={search} onLink={onLink} onClose={onClose} />
      ) : (
        <LinkDetails
          key={link}
          link={link}
          pending={pending}
          keyMissing={keyMissing}
          onChangeLink={() => onLink('')}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Première étape : aller chercher le lien sur le site, puis le coller ici. */
function WaitForLink({
  search,
  onLink,
  onClose,
}: {
  search: SourceSearch | null;
  onLink: (link: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const zone = useRef<HTMLDivElement>(null);
  // La fenêtre prend le focus à son ouverture : on le donne ensuite à la zone de collage.
  useEffect(() => {
    const timer = setTimeout(() => zone.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);
  const receive = (text: string) => {
    const link = findOneFichierLink(text);
    if (link) onLink(link);
    else setError('Ce texte ne contient pas de lien 1fichier (https://1fichier.com/?…).');
  };

  return (
    <div className="flex flex-col gap-5 pb-4">
      {search && (
        <ol className="flex flex-col gap-3">
          <Step number={1}>
            <span className="font-semibold text-white">{search.source}</span> s’est ouvert dans un
            nouvel onglet, sur la recherche de « {search.target} ».{' '}
            <a
              href={search.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-brand-300 underline-offset-2 hover:underline"
            >
              Rouvrir
              <ExternalLink className="size-3" />
            </a>
          </Step>
          <Step number={2}>
            Passez la vérification anti-robot du site, puis choisissez la version
            {search.season !== null
              ? ` de la saison ${search.season}. Prenez la saison complète si elle est proposée (archive .zip) : Lumière range chaque épisode.`
              : '.'}
          </Step>
          <Step number={3}>
            Copiez le lien 1fichier : bouton « Copier » du site, ou clic droit sur le lien puis «
            Copier l’adresse du lien ».
          </Step>
          <Step number={4}>Revenez ici et collez-le.</Step>
        </ol>
      )}

      <div
        // Zone de collage : Ctrl+V dès l'ouverture, sans cliquer nulle part.
        ref={zone}
        tabIndex={0}
        role="button"
        aria-label="Coller le lien 1fichier (Ctrl+V)"
        onPaste={(event) => {
          event.preventDefault();
          event.stopPropagation();
          receive(event.clipboardData.getData('text'));
        }}
        className="flex flex-col items-center gap-3 rounded-[1.25rem] border-2 border-dashed border-brand-300/40 bg-brand-400/[0.06] px-4 py-7 text-center outline-none focus-visible:border-brand-300 focus-visible:bg-brand-400/[0.1]"
      >
        <ClipboardPaste className="size-8 text-brand-300" />
        <p className="text-base font-semibold text-white">
          Faites <Kbd>Ctrl</Kbd> + <Kbd>V</Kbd> pour coller le lien 1fichier
        </p>
        <p className="text-xs text-zinc-400">
          N’importe où dans Lumière fonctionne aussi. Sur Mac : <Kbd>⌘</Kbd> + <Kbd>V</Kbd>.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          receive(typed);
        }}
      >
        <Input
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setError(null);
            if (findOneFichierLink(event.target.value)) receive(event.target.value);
          }}
          placeholder="ou collez-le dans ce champ : https://1fichier.com/?…"
          aria-label="Lien 1fichier"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-xs"
        />
      </form>
      {error && (
        <p className="-mt-3 flex items-center gap-1.5 text-xs text-red-300">
          <XCircle className="size-4 shrink-0" />
          {error}
        </p>
      )}

      <p className="text-xs leading-relaxed text-zinc-500">
        Plus rapide : le favori{' '}
        <Link
          to="/parametres?onglet=sources#favori"
          onClick={onClose}
          className="font-medium text-zinc-300 underline-offset-2 hover:underline"
        >
          « Envoyer à Lumière »
        </Link>{' '}
        envoie le lien en un clic depuis la page du site.
      </p>
    </div>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed text-zinc-300">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] text-xs font-semibold text-zinc-200 tabular-nums">
        {number}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-grid min-w-7 place-items-center rounded-md bg-white/[0.12] px-1.5 py-0.5 font-sans text-sm font-semibold text-white shadow-[inset_0_-2px_0_rgb(0_0_0/0.35)]">
      {children}
    </kbd>
  );
}

/** Seconde étape : le fichier (ou le contenu de l'archive) vérifié, puis le téléchargement. */
function LinkDetails({
  link,
  pending,
  keyMissing,
  onChangeLink,
  onClose,
}: {
  link: string;
  pending: PendingTitle | null;
  keyMissing: boolean;
  onChangeLink: () => void;
  onClose: () => void;
}) {
  const info = useOneFichierInfo();
  const enqueue = useEnqueueOneFichier();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [attach, setAttach] = useState(pending !== null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // Lien reçu : vérifié une fois auprès de 1fichier (nom, taille, contenu d'une archive).
  const { mutate: check } = info;
  useEffect(() => {
    if (!keyMissing) check({ url: link });
  }, [link, keyMissing, check]);

  const file = info.data;
  const archive = file?.archive ?? null;
  const chosen = archive?.streamable
    ? archive.entries.filter((entry) => !excluded.has(entry.path))
    : null;
  const submit = () =>
    enqueue.mutate(
      {
        url: link,
        password: password || undefined,
        titleId: attach ? pending?.id : null,
        season: attach ? pending?.season : null,
        entries: chosen?.map((entry) => entry.path),
      },
      { onSuccess: (result) => (result.created.length > 0 ? onClose() : undefined) },
    );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex min-w-0 items-center gap-2 rounded-[0.85rem] bg-white/[0.05] px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={link}>
          {link}
        </span>
        <Button size="sm" variant="ghost" onClick={onChangeLink}>
          Changer
        </Button>
      </div>

      {info.isPending && (
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="size-4 animate-spin" />
          Vérification auprès de 1fichier…
        </p>
      )}
      {info.isError && (
        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-1.5 text-sm text-red-300">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            {errorMessage(info.error)}
          </p>
          <div className="flex items-end gap-2">
            <Field label="Mot de passe du fichier, s’il en a un" className="flex-1">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Button
              variant="glass"
              className="h-11"
              onClick={() => info.mutate({ url: link, password: password || undefined })}
            >
              Réessayer
            </Button>
          </div>
        </div>
      )}
      {file && <FileSummary file={file} />}
      {archive && (
        <ArchiveEntries
          archive={archive}
          excluded={excluded}
          onToggle={(path) =>
            setExcluded((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })
          }
          onToggleAll={(all) =>
            setExcluded(all ? new Set() : new Set(archive.entries.map((entry) => entry.path)))
          }
          onPlay={(path) => {
            onClose();
            navigate(playerUrl({ type: 'remote', path }));
          }}
        />
      )}

      {pending ? (
        <Switch
          checked={attach}
          onChange={setAttach}
          label={`Rattacher à « ${pendingLabel(pending)} »`}
          description={`${pending.source ? `Cherché sur ${pending.source}` : 'Fiche ouverte'} : ${pending.kind === 'series' ? 'les épisodes rejoignent la série, saison par saison' : 'le fichier rejoint la fiche du film'}, et son dossier de la bibliothèque.`}
        />
      ) : (
        <p className="text-xs leading-relaxed text-zinc-400">
          Aucun titre en cours : le fichier sera rangé dans « Autres ». Pour le rattacher à un film
          ou à une série, passez par « Télécharger » sur sa fiche.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-2 pb-4">
        <Button variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button
          type="submit"
          variant="primary"
          icon={<Download className="size-4" />}
          loading={enqueue.isPending}
          disabled={keyMissing || !file || (chosen !== null && chosen.length === 0)}
        >
          {chosen ? `Télécharger ${plural(chosen.length, 'épisode')}` : 'Télécharger'}
        </Button>
      </div>
    </form>
  );
}

function FileSummary({ file }: { file: OneFichierFileInfo }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-[0.85rem] bg-emerald-400/[0.08] px-3 py-2.5 text-sm text-emerald-100">
      {file.archive || file.archiveError ? (
        <Archive className="mt-0.5 size-4 shrink-0" />
      ) : (
        <FileVideo className="mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0">
        <p className="font-mono text-xs break-all">{file.fileName}</p>
        <p className="mt-0.5 text-xs text-emerald-200/70">
          {formatBytes(file.size)}
          {file.archive &&
            ` · archive zip, ${plural(file.archive.entries.length, 'vidéo')} · ${
              file.archive.streamable
                ? 'chaque épisode se télécharge (ou se regarde) seul'
                : 'compressée : téléchargée en entier, puis décompressée'
            }`}
        </p>
        {file.archiveError && (
          <p className="mt-1 text-xs text-amber-200">
            Contenu illisible ({file.archiveError}) : l’archive sera téléchargée telle quelle.
          </p>
        )}
      </div>
    </div>
  );
}

/** Vidéos d'une archive : à cocher si elles se téléchargent une par une. */
function ArchiveEntries({
  archive,
  excluded,
  onToggle,
  onToggleAll,
  onPlay,
}: {
  archive: ArchiveContent;
  excluded: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (all: boolean) => void;
  /** Regarder une vidéo directement dans l'archive (non compressée), sans la télécharger. */
  onPlay: (path: string) => void;
}) {
  if (archive.entries.length === 0) return null;
  const selectable = archive.streamable;
  return (
    <div className="flex flex-col gap-1.5">
      {selectable && (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-xs font-medium text-brand-300 hover:text-brand-200"
            onClick={() => onToggleAll(excluded.size > 0)}
          >
            {excluded.size > 0 ? 'Tout cocher' : 'Tout décocher'}
          </button>
        </div>
      )}
      <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
        {archive.entries.map((entry) => {
          const code = episodeCode(entry.season, entry.episode);
          const checked = !excluded.has(entry.path);
          return (
            <li key={entry.path} className="flex items-center gap-1">
              <label
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2.5 rounded-[0.7rem] px-2.5 py-1.5 text-xs',
                  selectable ? 'cursor-pointer hover:bg-white/[0.05]' : '',
                  !checked && 'opacity-50',
                )}
              >
                {selectable && (
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(entry.path)}
                    className="size-4 accent-brand-400"
                  />
                )}
                {code && <span className="w-14 shrink-0 font-semibold text-zinc-200">{code}</span>}
                <span
                  className="min-w-0 flex-1 truncate font-mono text-zinc-400"
                  title={entry.name}
                >
                  {entry.name}
                </span>
                <span className="shrink-0 text-zinc-500">{formatBytes(entry.size)}</span>
              </label>
              {selectable && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={<Play className="size-3.5" />}
                  onClick={() => onPlay(entry.path)}
                  aria-label={`Regarder ${entry.name} sans le télécharger`}
                  title="Regarder directement dans l’archive, sans télécharger"
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
