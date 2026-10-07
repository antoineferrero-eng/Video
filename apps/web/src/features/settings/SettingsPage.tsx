import {
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Globe,
  KeyRound,
  PlayCircle,
  RefreshCw,
  Save,
  Server,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  AppSettings,
  SettingsResponse,
  SettingsUpdate,
  SourceConnection,
} from '@lumiere/shared';
import {
  useRefreshCatalog,
  useSettings,
  useSystemInfo,
  useTestSource,
  useTestTmdb,
  useUpdateSettings,
} from '../../api/queries';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { PageLoader } from '../../components/ui/Spinner';
import { ErrorState } from '../../components/ui/States';
import { Switch } from '../../components/ui/Switch';
import { Tabs } from '../../components/ui/Tabs';
import { setAppearance, useAppearance, type GlassMaterial } from '../../design/glass/appearance';
import { Glass } from '../../design/glass/Glass';
import { cn } from '../../lib/cn';
import { formatBytes, formatRelativeDate } from '../../lib/format';

const LANGUAGES = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'es', label: 'Espagnol' },
  { value: 'de', label: 'Allemand' },
  { value: 'it', label: 'Italien' },
  { value: 'ja', label: 'Japonais' },
];

const CONNECTIONS: Array<{ value: SourceConnection; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Automatique (recommandé)',
    description:
      'Connexion standard, puis imitation de Chrome ; si Cloudflare exige une vérification (« Just a moment… »), ZenRows si une clé est configurée, sinon votre navigateur.',
  },
  {
    value: 'standard',
    label: 'Standard',
    description: 'Requêtes avec les en-têtes d’un navigateur et le User-Agent ci-contre.',
  },
  {
    value: 'browser',
    label: 'Imitation de navigateur',
    description:
      'Reproduit l’empreinte réseau de Chrome (TLS, HTTP/2) pour toutes les requêtes vers la source.',
  },
  {
    value: 'real-browser',
    label: 'Navigateur réel (Chrome, Edge…)',
    description:
      'Votre navigateur passe la vérification Cloudflare dans une petite fenêtre (cochez la case si elle apparaît), puis Lumière réutilise ce passage.',
  },
  {
    value: 'zenrows',
    label: 'ZenRows (service en ligne)',
    description:
      'Les pages de listing passent par ZenRows, qui franchit la vérification Cloudflare ; les fichiers sont téléchargés directement. Le navigateur n’est jamais ouvert.',
  },
];

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <PageLoader />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  // Le formulaire est réinitialisé à chaque nouvelle version des paramètres enregistrés.
  return <SettingsForm key={JSON.stringify(settings.data)} response={settings.data} />;
}

function SettingsForm({ response }: { response: SettingsResponse }) {
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<AppSettings>(response.settings);
  const [tmdbKey, setTmdbKey] = useState('');
  const [zenrowsKey, setZenrowsKey] = useState('');

  const changes = useMemo(() => {
    const patch: SettingsUpdate = {};
    for (const key of Object.keys(draft) as Array<keyof AppSettings>) {
      if (draft[key] !== response.settings[key])
        (patch as Record<string, unknown>)[key] = draft[key];
    }
    if (tmdbKey.trim()) patch.tmdbApiKey = tmdbKey.trim();
    if (zenrowsKey.trim()) patch.zenrowsApiKey = zenrowsKey.trim();
    return patch;
  }, [draft, response.settings, tmdbKey, zenrowsKey]);
  const dirty = Object.keys(changes).length > 0;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });
  const save = () => update.mutate(changes);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-16">
      <header>
        <h1 className="large-title">Paramètres</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Apparence, source des fichiers, téléchargements, lecture et métadonnées.
        </p>
      </header>

      <AppearanceSection />

      <Section
        tone="blue"
        icon={<Globe />}
        title="Source"
        description="Index HTTP (listing de dossiers) depuis lequel les films et séries sont récupérés."
      >
        <Field label="Adresse de la source" description="Exemple : https://a.111477.xyz">
          <Input
            value={draft.sourceBaseUrl}
            onChange={(event) => set('sourceBaseUrl', event.target.value)}
            spellCheck={false}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dossier des films" description="Chemin relatif sur la source.">
            <Input
              value={draft.moviesPath}
              onChange={(event) => set('moviesPath', event.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="Dossier des séries">
            <Input
              value={draft.seriesPath}
              onChange={(event) => set('seriesPath', event.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[15rem_1fr]">
          <Field
            label="Connexion à la source"
            description={
              CONNECTIONS.find((item) => item.value === draft.sourceConnection)?.description
            }
          >
            <Select
              value={draft.sourceConnection}
              onChange={(event) => set('sourceConnection', event.target.value as SourceConnection)}
            >
              {CONNECTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="User-Agent HTTP"
            description="Identité de la connexion standard (l’imitation de navigateur utilise celle de Chrome)."
          >
            <Input
              value={draft.userAgent}
              onChange={(event) => set('userAgent', event.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
        </div>
        <ZenRowsField
          configured={response.zenrowsApiKeyConfigured}
          fromEnv={response.zenrowsApiKeyFromEnv}
          value={zenrowsKey}
          onChange={setZenrowsKey}
        />
        <SourceTester />
      </Section>

      <Section tone="green" icon={<Download />} title="Téléchargements">
        <Field
          label="Dossier de la bibliothèque"
          description="Les films sont rangés dans « Films/ », les séries dans « Séries/<série>/Saison NN/ »."
        >
          <Input
            value={draft.downloadDir}
            onChange={(event) => set('downloadDir', event.target.value)}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Téléchargements simultanés">
            <Select
              value={draft.maxConcurrentDownloads}
              onChange={(event) => set('maxConcurrentDownloads', Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Limite de débit (Kio/s)" description="0 = illimité">
            <Input
              type="number"
              min={0}
              step={512}
              value={draft.maxDownloadSpeedKbps}
              onChange={(event) =>
                set('maxDownloadSpeedKbps', Math.max(0, Number(event.target.value) || 0))
              }
            />
          </Field>
          <Field label="Qualité préférée" description="Utilisée pour les saisons complètes.">
            <Select
              value={draft.preferredQuality}
              onChange={(event) =>
                set('preferredQuality', event.target.value as AppSettings['preferredQuality'])
              }
            >
              <option value="2160p">4K (2160p)</option>
              <option value="1080p">Full HD (1080p)</option>
              <option value="720p">HD (720p)</option>
              <option value="smallest">La plus légère</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section tone="red" icon={<PlayCircle />} title="Lecture">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Langue audio préférée"
            description="Sélectionnée automatiquement dans les fichiers multi-langues (MULTi)."
          >
            <Select
              value={draft.preferredAudioLanguage}
              onChange={(event) => set('preferredAudioLanguage', event.target.value)}
            >
              <option value="">Piste par défaut du fichier</option>
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sous-titres par défaut">
            <Select
              value={draft.preferredSubtitleLanguage}
              onChange={(event) => set('preferredSubtitleLanguage', event.target.value)}
            >
              <option value="">Désactivés (sauf sous-titres forcés)</option>
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Conversion vidéo"
            description="Utilisée quand le navigateur ne sait pas lire le fichier (HEVC, 10 bits…)."
          >
            <Select
              value={draft.transcodePreset}
              onChange={(event) =>
                set('transcodePreset', event.target.value as AppSettings['transcodePreset'])
              }
            >
              <option value="quality">Qualité maximale (plus de CPU)</option>
              <option value="balanced">Équilibrée</option>
              <option value="fast">Rapide (machines modestes)</option>
            </Select>
          </Field>
          <Field label="Résolution maximale convertie">
            <Select
              value={draft.maxTranscodeHeight}
              onChange={(event) => set('maxTranscodeHeight', Number(event.target.value))}
            >
              {[2160, 1440, 1080, 720, 480].map((value) => (
                <option key={value} value={value}>
                  {value}p
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      <Section
        tone="teal"
        icon={<KeyRound />}
        title="Métadonnées (TMDB)"
        description="Affiches, résumés, notes et titres d'épisodes proviennent de The Movie Database (clé gratuite)."
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {response.tmdbApiKeyConfigured ? (
            <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
              Clé configurée{response.tmdbApiKeyFromEnv ? ' (variable d’environnement)' : ''}
            </Badge>
          ) : (
            <Badge tone="warning">Aucune clé : les affiches sont générées automatiquement</Badge>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field
            label={response.tmdbApiKeyConfigured ? 'Remplacer la clé API' : 'Clé API TMDB'}
            description={
              <>
                Créez un compte sur{' '}
                <a
                  href="https://www.themoviedb.org/settings/api"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-brand-300 underline underline-offset-2"
                >
                  themoviedb.org/settings/api
                </a>{' '}
                puis copiez la « clé d'API » (v3) ou le « jeton d'accès en lecture ».
              </>
            }
          >
            <Input
              type="password"
              value={tmdbKey}
              onChange={(event) => setTmdbKey(event.target.value)}
              placeholder="••••••••••••"
              autoComplete="off"
            />
          </Field>
          <Field label="Langue des métadonnées">
            <Select
              value={draft.metadataLanguage}
              onChange={(event) => set('metadataLanguage', event.target.value)}
            >
              <option value="fr-FR">Français</option>
              <option value="en-US">Anglais</option>
              <option value="es-ES">Espagnol</option>
              <option value="de-DE">Allemand</option>
              <option value="it-IT">Italien</option>
            </Select>
          </Field>
        </div>
        <TmdbTester candidate={tmdbKey} />
      </Section>

      <CatalogSection
        refreshHours={draft.catalogRefreshHours}
        onRefreshHours={(value) => set('catalogRefreshHours', value)}
      />
      <SystemSection />

      {/* Barre d'enregistrement flottante en verre épais (couche fonctionnelle). */}
      <Glass
        variant="thick"
        role="region"
        aria-label="Modifications non enregistrées"
        aria-hidden={!dirty}
        className={cn(
          'fixed right-0 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] left-0 z-40 mx-auto flex w-[min(92vw,40rem)] items-center justify-between gap-4 rounded-full py-2 pr-2 pl-5 transition duration-500 ease-spring lg:bottom-6 lg:left-[var(--sidebar-width)]',
          dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-8 opacity-0',
        )}
      >
        <span className="text-sm font-medium text-zinc-100">Modifications non enregistrées</span>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            tabIndex={dirty ? undefined : -1}
            onClick={() => {
              setDraft(response.settings);
              setTmdbKey('');
              setZenrowsKey('');
            }}
          >
            Annuler
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Save className="size-4" />}
            loading={update.isPending}
            tabIndex={dirty ? undefined : -1}
            onClick={save}
          >
            Enregistrer
          </Button>
        </div>
      </Glass>
    </div>
  );
}

const MATERIALS: Array<{ value: GlassMaterial; label: string; description: string }> = [
  {
    value: 'clear',
    label: 'Transparent',
    description:
      'Liquid Glass : le verre laisse transparaître le contenu et réfracte la lumière sur ses bords.',
  },
  {
    value: 'tinted',
    label: 'Teinté',
    description: 'Verre plus opaque et plus contrasté, pour une lecture plus confortable.',
  },
  {
    value: 'solid',
    label: 'Opaque',
    description: 'Surfaces givrées sans transparence (équivalent de « Réduire la transparence »).',
  },
];

/** Réglages d'apparence propres à l'appareil (stockés localement, appliqués immédiatement). */
function AppearanceSection() {
  const appearance = useAppearance();
  const { preferences, system, refractionSupported } = appearance;
  const current = MATERIALS.find((item) => item.value === preferences.material) ?? MATERIALS[0];
  return (
    <Section
      tone="violet"
      icon={<Sparkles />}
      title="Apparence"
      description="Réglages propres à cet appareil, appliqués immédiatement."
    >
      <div className="flex flex-col gap-2">
        <span className="px-1 text-sm font-medium text-zinc-200">Matériau des barres et menus</span>
        <Tabs<GlassMaterial>
          kind="radio"
          label="Matériau des barres et menus"
          items={MATERIALS.map(({ value, label }) => ({ value, label }))}
          value={preferences.material}
          onChange={(material) => setAppearance({ material })}
        />
        <p className="px-1 text-xs leading-relaxed text-zinc-400">
          {system.reducedTransparency
            ? '« Réduire la transparence » est activé sur cet appareil : les surfaces restent opaques.'
            : current?.description}
        </p>
      </div>
      <div className="flex flex-col gap-5 border-t border-white/[0.07] pt-5">
        <Switch
          label="Réfraction des bords (effet lentille)"
          description={
            !refractionSupported
              ? 'Nécessite un navigateur basé sur Chromium (Chrome, Edge, Brave, Opera) ; ailleurs, le verre reste dépoli.'
              : appearance.refractionThrottled
                ? 'Désactivée automatiquement : l’affichage était saccadé sur cet appareil. Réactivez-la pour forcer l’effet.'
                : 'Le verre courbe la lumière sur ses contours. À désactiver sur une machine modeste.'
          }
          checked={refractionSupported && preferences.refraction && !appearance.refractionThrottled}
          disabled={!refractionSupported || appearance.material === 'solid'}
          onChange={(refraction) => setAppearance({ refraction })}
        />
        <Switch
          label="Reflets dynamiques"
          description={
            system.reducedMotion
              ? '« Réduire les animations » est activé sur cet appareil : reflets fixes.'
              : "Les reflets suivent le pointeur ou l'inclinaison de l'appareil."
          }
          checked={appearance.lightActive}
          disabled={system.reducedMotion || appearance.material === 'solid'}
          onChange={(dynamicLight) => setAppearance({ dynamicLight })}
        />
      </div>
    </Section>
  );
}

/** Pastilles d'icônes colorées, à la manière des Réglages d'iOS. */
const TONES = {
  violet: 'from-violet-400 to-violet-600',
  blue: 'from-sky-400 to-blue-600',
  green: 'from-emerald-400 to-green-600',
  red: 'from-rose-400 to-red-600',
  teal: 'from-teal-300 to-cyan-600',
  indigo: 'from-indigo-400 to-indigo-600',
  gray: 'from-zinc-400 to-zinc-600',
} as const;

function Section({
  icon,
  title,
  description,
  tone = 'gray',
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <section className="fill flex flex-col gap-5 rounded-card p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-gradient-to-b text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_6px_14px_-6px_rgb(0_0_0/0.7)] [&>svg]:size-5',
            TONES[tone],
          )}
        >
          {icon}
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          {description && <p className="text-sm text-zinc-400">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const TRANSPORT_LABELS = {
  standard: '',
  browser: ' · via l’imitation de Chrome',
  'real-browser': ' · via votre navigateur (vérification Cloudflare)',
  zenrows: ' · via ZenRows',
  cdn: ' · via p.111477.xyz',
} as const;

/** Clé ZenRows : service en ligne payant qui franchit les vérifications anti-robot. */
function ZenRowsField({
  configured,
  fromEnv,
  value,
  onChange,
}: {
  configured: boolean;
  fromEnv: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const usage = useSystemInfo().data?.zenrows;
  return (
    <div className="flex flex-col gap-3 rounded-[1rem] bg-white/[0.05] p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">ZenRows</span>
        {configured ? (
          <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
            Clé configurée{fromEnv ? ' (variable d’environnement)' : ''}
          </Badge>
        ) : (
          <Badge tone="neutral">Facultatif</Badge>
        )}
        {usage && (
          <span className="text-xs text-zinc-400">
            Depuis le démarrage : {usage.pages} page(s), {usage.credits} crédit(s)
          </span>
        )}
      </div>
      <Field
        label={configured ? 'Remplacer la clé API ZenRows' : 'Clé API ZenRows'}
        description={
          <>
            Service en ligne payant au crédit qui franchit la vérification Cloudflare pour les pages
            de listing (jusqu’à 25 crédits par page, échecs non facturés) ; les fichiers restent
            téléchargés directement. Clé sur{' '}
            <a
              href="https://app.zenrows.com/builder"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand-300 underline underline-offset-2"
            >
              app.zenrows.com
            </a>
            .
          </>
        }
      >
        <Input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="••••••••••••"
          autoComplete="off"
        />
      </Field>
    </div>
  );
}

function SourceTester() {
  const test = useTestSource();
  const result = test.data;
  return (
    <div className="flex flex-col gap-3 rounded-[1rem] bg-white/[0.05] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="glass"
          icon={<Server className="size-4" />}
          loading={test.isPending}
          onClick={() => test.mutate(undefined)}
        >
          Tester la source enregistrée
        </Button>
        {result && (
          <span
            className={cn(
              'flex items-center gap-1.5 text-sm',
              result.ok ? 'text-emerald-300' : 'text-red-300',
            )}
          >
            {result.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {result.ok
              ? `Source joignable · ${result.directories} dossier(s), ${result.files} fichier(s) · format ${result.format} · ${result.durationMs} ms${TRANSPORT_LABELS[result.transport ?? 'standard']}`
              : (result.error ?? 'Échec')}
          </span>
        )}
      </div>
      {result?.ok && result.sample.length > 0 && (
        <ul className="grid gap-1 font-mono text-xs text-zinc-400 sm:grid-cols-2">
          {result.sample.map((entry) => (
            <li key={entry.path} className="truncate">
              {entry.kind === 'directory' ? '📁' : '📄'} {entry.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TmdbTester({ candidate }: { candidate: string }) {
  const test = useTestTmdb();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant="glass"
        loading={test.isPending}
        onClick={() => test.mutate(candidate.trim() || undefined)}
      >
        Tester la clé
      </Button>
      {test.data && (
        <span
          className={cn(
            'flex items-center gap-1.5 text-sm',
            test.data.ok ? 'text-emerald-300' : 'text-red-300',
          )}
        >
          {test.data.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
          {test.data.message}
        </span>
      )}
    </div>
  );
}

function CatalogSection({
  refreshHours,
  onRefreshHours,
}: {
  refreshHours: number;
  onRefreshHours: (value: number) => void;
}) {
  const system = useSystemInfo();
  const refresh = useRefreshCatalog();
  return (
    <Section
      tone="indigo"
      icon={<Database />}
      title="Catalogue"
      description="Liste des titres lue sur la source et mise en cache localement."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {system.data?.catalog.map((section) => (
          <div key={section.kind} className="rounded-[1rem] bg-white/[0.05] p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{section.kind === 'movie' ? 'Films' : 'Séries'}</span>
              <Badge
                tone={
                  section.state === 'error'
                    ? 'danger'
                    : section.state === 'refreshing'
                      ? 'brand'
                      : 'success'
                }
              >
                {section.state === 'error'
                  ? 'Erreur'
                  : section.state === 'refreshing'
                    ? 'Actualisation…'
                    : `${section.count} titres`}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-zinc-400">{section.path}</p>
            <p className="mt-1 text-xs text-zinc-400">
              {section.lastRefreshAt
                ? `Actualisé ${formatRelativeDate(section.lastRefreshAt)}`
                : 'Jamais actualisé'}
            </p>
            {section.lastError && <p className="mt-1 text-xs text-red-300">{section.lastError}</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Actualisation automatique" className="w-56">
          <Select
            value={refreshHours}
            onChange={(event) => onRefreshHours(Number(event.target.value))}
          >
            <option value={0}>Manuelle uniquement</option>
            {[1, 3, 6, 12, 24, 48].map((value) => (
              <option key={value} value={value}>
                Toutes les {value} h
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="glass"
          className="h-11"
          icon={<RefreshCw className="size-4" />}
          loading={refresh.isPending}
          onClick={() => refresh.mutate(undefined)}
        >
          Actualiser maintenant
        </Button>
      </div>
    </Section>
  );
}

function SystemSection() {
  const system = useSystemInfo();
  const info = system.data;
  if (!info) return null;
  const rows: Array<[string, ReactNode]> = [
    ['Version', info.version],
    ['Node.js', `${info.nodeVersion} (${info.platform})`],
    [
      'ffmpeg',
      info.ffmpeg.available && info.ffmpeg.ffprobeAvailable ? (
        <span className="text-emerald-300">Disponible ({info.ffmpeg.version})</span>
      ) : (
        <span className="text-amber-300">
          Introuvable : installez ffmpeg pour lire tous les formats
        </span>
      ),
    ],
    [
      'Navigateur',
      info.browser ? (
        <span>
          {info.browser.name} <span className="text-zinc-400">(vérifications Cloudflare)</span>
        </span>
      ) : (
        <span className="text-amber-300">
          Aucun trouvé : installez Chrome ou Edge si la source exige une vérification Cloudflare
        </span>
      ),
    ],
    [
      'Espace disque',
      info.disk ? `${formatBytes(info.disk.free)} libres sur ${formatBytes(info.disk.total)}` : '—',
    ],
    ['Données', <span className="font-mono text-xs">{info.dataDir}</span>],
  ];
  return (
    <Section tone="gray" icon={<Cpu />} title="Système">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-400">{label}</dt>
            <dd className="text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
