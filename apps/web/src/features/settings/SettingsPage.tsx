import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  KeyRound,
  Languages,
  Play,
  PlayCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Server,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { AppSettings, SettingsResponse, SettingsUpdate } from '@lumiere/shared';
import { errorMessage } from '../../api/client';
import {
  useRefreshCatalog,
  useSettings,
  useSystemInfo,
  useTestAddon,
  useTestSubtitles,
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
import { formatBytes, formatRelativeDate, plural } from '../../lib/format';

const LANGUAGES = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'es', label: 'Espagnol' },
  { value: 'de', label: 'Allemand' },
  { value: 'it', label: 'Italien' },
  { value: 'ja', label: 'Japonais' },
];

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <PageLoader />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  // Le formulaire est réinitialisé à chaque nouvelle version des paramètres enregistrés.
  return <SettingsForm key={JSON.stringify(settings.data)} response={settings.data} />;
}

type SettingsTab = 'general' | 'services' | 'catalog' | 'system';

const TABS: Array<{ value: SettingsTab; label: string }> = [
  { value: 'general', label: 'Général' },
  { value: 'services', label: 'Extensions et API' },
  { value: 'catalog', label: 'Catalogue' },
  { value: 'system', label: 'Système' },
];

/** Réglages enregistrés de chaque onglet (pastille : modifications pas encore enregistrées). */
const TAB_FIELDS: Record<SettingsTab, Array<keyof SettingsUpdate>> = {
  general: [
    'preferredAudioLanguage',
    'preferredSubtitleLanguage',
    'metadataLanguage',
    'transcodePreset',
    'maxTranscodeHeight',
    'downloadDir',
    'maxConcurrentDownloads',
    'maxDownloadSpeedKbps',
    'preferredQuality',
  ],
  services: [
    'stremioAddonUrls',
    'subtitleAddonUrls',
    'tmdbApiKey',
    'openSubtitlesApiKey',
    'openSubtitlesUsername',
    'openSubtitlesPassword',
  ],
  catalog: ['catalogRefreshHours'],
  system: [],
};

function parseTab(value: string | null): SettingsTab {
  // « source » : ancien nom de l'onglet du catalogue (liens enregistrés).
  if (value === 'source') return 'catalog';
  return TABS.some((tab) => tab.value === value) ? (value as SettingsTab) : 'general';
}

const METADATA_LANGUAGES = [
  { value: 'fr-FR', label: 'Français' },
  { value: 'en-US', label: 'Anglais' },
  { value: 'es-ES', label: 'Espagnol' },
  { value: 'de-DE', label: 'Allemand' },
  { value: 'it-IT', label: 'Italien' },
];

function SettingsForm({ response }: { response: SettingsResponse }) {
  const update = useUpdateSettings();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('onglet'));
  const [draft, setDraft] = useState<AppSettings>(response.settings);
  const [tmdbKey, setTmdbKey] = useState('');
  const [openSubtitlesKey, setOpenSubtitlesKey] = useState('');
  const [openSubtitlesPassword, setOpenSubtitlesPassword] = useState('');

  const changes = useMemo(() => {
    const patch: SettingsUpdate = {};
    for (const key of Object.keys(draft) as Array<keyof AppSettings>) {
      // Les listes sont comparées par contenu (une nouvelle liste à chaque saisie).
      if (JSON.stringify(draft[key]) !== JSON.stringify(response.settings[key]))
        (patch as Record<string, unknown>)[key] = draft[key];
    }
    if (tmdbKey.trim()) patch.tmdbApiKey = tmdbKey.trim();
    if (openSubtitlesKey.trim()) patch.openSubtitlesApiKey = openSubtitlesKey.trim();
    if (openSubtitlesPassword) patch.openSubtitlesPassword = openSubtitlesPassword;
    return patch;
  }, [draft, response.settings, tmdbKey, openSubtitlesKey, openSubtitlesPassword]);
  const dirty = Object.keys(changes).length > 0;
  const pending = (value: SettingsTab) => TAB_FIELDS[value].filter((key) => key in changes).length;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });
  const save = () => update.mutate(changes);
  const cancel = () => {
    setDraft(response.settings);
    setTmdbKey('');
    setOpenSubtitlesKey('');
    setOpenSubtitlesPassword('');
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-16">
      <header className="flex flex-col gap-4">
        <div>
          <h1 className="large-title">Paramètres</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Préférences de lecture et d’apparence, extensions Stremio et services connectés.
          </p>
        </div>
        <Tabs<SettingsTab>
          label="Rubriques des paramètres"
          items={TABS.map(({ value, label }) => ({
            value,
            label,
            count: pending(value) > 0 ? pending(value) : undefined,
          }))}
          value={tab}
          onChange={(value) => setParams({ onglet: value }, { replace: true })}
        />
      </header>

      {tab === 'general' && (
        <div role="tabpanel" aria-label="Général" className="flex flex-col gap-6">
          <AppearanceSection />

          <Section
            tone="blue"
            icon={<Languages />}
            title="Langues"
            description="Choisies automatiquement à la lecture et pour les fiches des titres."
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Langue audio préférée"
                description="Sélectionnée dans les fichiers multi-langues (MULTi)."
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
              <Field
                label="Sous-titres par défaut"
                description="Absents du fichier : cherchés en ligne."
              >
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
              <Field label="Langue des fiches" description="Titres, résumés et épisodes (TMDB).">
                <Select
                  value={draft.metadataLanguage}
                  onChange={(event) => set('metadataLanguage', event.target.value)}
                >
                  {METADATA_LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Section>

          <Section
            tone="red"
            icon={<PlayCircle />}
            title="Lecture"
            description="Conversion des vidéos que le navigateur ne sait pas lire (HEVC, 10 bits…)."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Qualité de conversion">
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
        </div>
      )}

      {tab === 'services' && (
        <div role="tabpanel" aria-label="Extensions et API" className="flex flex-col gap-6">
          <Section
            tone="violet"
            icon={<Puzzle />}
            title="Extensions Stremio"
            description="Services au protocole des extensions Stremio : liens des fichiers et sous-titres en ligne."
          >
            <StreamAddonsGroup
              urls={draft.stremioAddonUrls}
              onChange={(urls) => set('stremioAddonUrls', urls)}
            />
            <SubtitleAddonsGroup
              urls={draft.subtitleAddonUrls}
              onChange={(urls) => set('subtitleAddonUrls', urls)}
            />
          </Section>

          <Section
            tone="teal"
            icon={<KeyRound />}
            title="Clés d’API"
            description="Services en ligne qui demandent une clé personnelle, gratuite. Les clés et mots de passe ne sont jamais réaffichés."
          >
            <Group
              title="TMDB"
              badge={
                response.tmdbApiKeyConfigured ? (
                  <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
                    Clé configurée{response.tmdbApiKeyFromEnv ? ' (variable d’environnement)' : ''}
                  </Badge>
                ) : (
                  <Badge tone="warning">Indispensable : le catalogue en dépend</Badge>
                )
              }
              description="Catalogue (tendances, populaires, recherche), affiches, résumés, notes et titres des épisodes."
            >
              <Field
                label={response.tmdbApiKeyConfigured ? 'Remplacer la clé' : 'Clé d’API'}
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
                    puis copiez la « clé d’API » (v3) ou le « jeton d’accès en lecture ».
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
              <TmdbTester candidate={tmdbKey} />
            </Group>
            <OpenSubtitlesGroup
              response={response}
              username={draft.openSubtitlesUsername}
              onUsernameChange={(value) => set('openSubtitlesUsername', value)}
              apiKey={openSubtitlesKey}
              onApiKeyChange={setOpenSubtitlesKey}
              password={openSubtitlesPassword}
              onPasswordChange={setOpenSubtitlesPassword}
            />
          </Section>
        </div>
      )}

      {tab === 'catalog' && (
        <div role="tabpanel" aria-label="Catalogue" className="flex flex-col gap-6">
          <CatalogSection
            refreshHours={draft.catalogRefreshHours}
            onRefreshHours={(value) => set('catalogRefreshHours', value)}
          />
        </div>
      )}

      {tab === 'system' && (
        <div role="tabpanel" aria-label="Système" className="flex flex-col gap-6">
          <SystemSection />
        </div>
      )}

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
          <Button variant="ghost" size="sm" tabIndex={dirty ? undefined : -1} onClick={cancel}>
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
  const solid = appearance.material === 'solid';
  return (
    <Section
      tone="violet"
      icon={<Sparkles />}
      title="Apparence"
      description="Barres, menus et commandes du lecteur en verre. Réglages propres à cet appareil, appliqués immédiatement."
    >
      <AppearancePreview />
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
              : solid
                ? 'Sans effet avec le matériau « Opaque » : le verre ne laisse rien transparaître.'
                : appearance.refractionThrottled
                  ? 'Désactivée automatiquement : l’affichage était saccadé sur cet appareil. Réactivez-la pour forcer l’effet.'
                  : 'Le verre courbe la lumière sur ses contours. À désactiver sur une machine modeste.'
          }
          checked={
            refractionSupported &&
            preferences.refraction &&
            !appearance.refractionThrottled &&
            !solid
          }
          disabled={!refractionSupported || solid}
          onChange={(refraction) => setAppearance({ refraction })}
        />
        <Switch
          label="Reflets dynamiques"
          description={
            system.reducedMotion
              ? '« Réduire les animations » est activé sur cet appareil : reflets fixes.'
              : solid
                ? 'Sans effet avec le matériau « Opaque ».'
                : "Les reflets suivent le pointeur ou l'inclinaison de l'appareil."
          }
          checked={appearance.lightActive}
          disabled={system.reducedMotion || solid}
          onChange={(dynamicLight) => setAppearance({ dynamicLight })}
        />
      </div>
    </Section>
  );
}

/**
 * Aperçu du verre sur un fond coloré et détaillé : le matériau, la réfraction des bords et les
 * reflets s'y voient tout de suite (le contenu des pages, sombre, les laisse peu paraître).
 */
function AppearancePreview() {
  return (
    <div
      aria-hidden="true"
      className="relative h-44 overflow-hidden rounded-[1rem] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 16% 28%, #f472b6 0, transparent 34%), radial-gradient(circle at 80% 22%, #38bdf8 0, transparent 36%), radial-gradient(circle at 58% 92%, #facc15 0, transparent 40%), linear-gradient(135deg, #4c1d95, #0f172a)',
        }}
      />
      {/* Motif net : la transparence et la courbure des bords se lisent dessus. */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            'repeating-linear-gradient(100deg, rgb(255 255 255 / 0.55) 0 2px, transparent 2px 18px)',
        }}
      />
      <p className="absolute inset-x-0 top-6 text-center text-4xl font-black tracking-tight text-white">
        Lumière
      </p>
      <Glass
        lens={{ bezel: 18, strength: 20 }}
        className="absolute inset-x-5 bottom-5 flex items-center gap-3 rounded-full py-2 pr-4 pl-2 sm:inset-x-10"
      >
        <span className="glass glass-clear flex size-10 shrink-0 items-center justify-center rounded-full">
          <Play className="ml-0.5 size-4 fill-white text-white" />
        </span>
        <span className="min-w-0 truncate text-sm font-semibold">Aperçu du verre</span>
        <span className="ml-auto hidden text-xs text-zinc-300 sm:inline">
          Les reflets suivent le pointeur
        </span>
      </Glass>
    </div>
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
  orange: 'from-amber-300 to-orange-500',
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

/** Extension de 111477 (celle par défaut), qui fournit ses fichiers. */
const DEFAULT_STREAM_ADDON = 'https://st.111477.xyz/manifest.json';

/**
 * Extensions Stremio qui fournissent les fichiers, par ordre de préférence : toutes sont
 * interrogées, leurs fichiers réunis ; un fichier proposé par plusieurs garde la première
 * comme lien principal et les suivantes en secours.
 */
function StreamAddonsGroup({
  urls,
  onChange,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const add = (value: string) => {
    const url = value.trim();
    if (!url || urls.includes(url)) return;
    onChange([...urls, url]);
    setInput('');
  };
  const move = (index: number, offset: number) => {
    const next = [...urls];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + offset, 0, item);
    onChange(next);
  };
  return (
    <Group
      title="Films et séries"
      badge={
        <Badge tone={urls.length > 0 ? 'success' : 'warning'}>
          {urls.length > 0 ? plural(urls.length, 'extension') : 'Aucune : rien à lire'}
        </Badge>
      }
      description="Fournissent les liens des films et des épisodes du catalogue (qui, lui, vient de TMDB). Toutes sont interrogées et leurs fichiers réunis ; quand plusieurs proposent le même fichier, la première de la liste sert, les suivantes prennent le relais si son lien est refusé."
    >
      {urls.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="Extensions, par ordre de préférence">
          {urls.map((url, index) => (
            <StreamAddonRow
              key={url}
              url={url}
              position={index + 1}
              first={index === 0}
              last={index === urls.length - 1}
              onUp={() => move(index, -1)}
              onDown={() => move(index, 1)}
              onRemove={() => onChange(urls.filter((item) => item !== url))}
            />
          ))}
        </ol>
      )}
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          add(input);
        }}
      >
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="stremio://… ou https://…/manifest.json"
          aria-label="Adresse d’une extension à ajouter"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="submit"
          variant="glass"
          className="h-11"
          icon={<Plus className="size-4" />}
          disabled={!input.trim() || urls.includes(input.trim())}
        >
          Ajouter
        </Button>
      </form>
      {!urls.includes(DEFAULT_STREAM_ADDON) && (
        <div>
          <Button size="sm" variant="glass" onClick={() => add(DEFAULT_STREAM_ADDON)}>
            Ajouter l’extension de 111477
          </Button>
        </div>
      )}
      <p className="text-xs leading-relaxed text-zinc-400">
        Collez le lien d’installation d’une extension (après l’avoir configurée sur sa page, si elle
        le demande). Les liens ne sont demandés qu’à l’ouverture d’un film, ou à la lecture et au
        téléchargement d’un épisode : chez 111477, chaque lien consomme un jeton d’une réserve
        limitée par adresse IP, réglez l’extension pour qu’elle propose peu de liens par titre.
      </p>
    </Group>
  );
}

function StreamAddonRow({
  url,
  position,
  first,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  url: string;
  position: number;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const test = useTestAddon();
  const result = test.data;
  return (
    <li className="flex flex-col gap-2 rounded-[0.85rem] bg-white/[0.05] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] text-xs font-semibold text-zinc-300 tabular-nums">
          {position}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title={url}>
          {url}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Monter (préférer cette extension)"
            disabled={first}
            onClick={onUp}
            icon={<ArrowUp className="size-4" />}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Descendre"
            disabled={last}
            onClick={onDown}
            icon={<ArrowDown className="size-4" />}
          />
          <Button
            size="sm"
            variant="ghost"
            loading={test.isPending}
            onClick={() => test.mutate(url)}
            icon={<Server className="size-4" />}
          >
            <span className="hidden sm:inline">Tester</span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Retirer cette extension"
            onClick={onRemove}
            icon={<Trash2 className="size-4" />}
          />
        </div>
      </div>
      {result && (
        <span
          className={cn(
            'flex min-w-0 items-start gap-1.5 text-xs',
            result.ok ? 'text-emerald-300' : 'text-red-300',
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <XCircle className="size-4 shrink-0" />
          )}
          {result.message}
        </span>
      )}
      {test.isError && <p className="text-xs text-red-300">{errorMessage(test.error)}</p>}
    </li>
  );
}

const OPENSUBTITLES_V3 = 'https://opensubtitles-v3.strem.io/manifest.json';

/** Sous-partie d'une section : un service, avec son état et ses réglages. */
function Group({
  title,
  badge,
  description,
  children,
}: {
  title: string;
  badge?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[1rem] bg-white/[0.05] p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {badge}
        </div>
        {description && <p className="text-xs leading-relaxed text-zinc-400">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Résultats d'un test de services de sous-titres. */
function ProviderResults({ test }: { test: ReturnType<typeof useTestSubtitles> }) {
  return (
    <>
      {test.data?.providers.length === 0 && (
        <p className="text-sm text-zinc-400">Aucun service configuré.</p>
      )}
      {test.data?.providers.map((provider) => (
        <span
          key={provider.name}
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-sm',
            provider.ok ? 'text-emerald-300' : 'text-red-300',
          )}
        >
          {provider.ok ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <XCircle className="size-4 shrink-0" />
          )}
          <span className="font-medium">{provider.name}</span> · {provider.message}
        </span>
      ))}
      {test.isError && <p className="text-sm text-red-300">{errorMessage(test.error)}</p>}
    </>
  );
}

/** Extensions Stremio de sous-titres (une adresse de manifeste par ligne). */
function SubtitleAddonsGroup({
  urls,
  onChange,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
}) {
  // Texte libre (une adresse par ligne) : la liste enregistrée en est déduite.
  const [text, setText] = useState(urls.join('\n'));
  const test = useTestSubtitles();
  const update = (value: string) => {
    setText(value);
    onChange(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  };
  return (
    <Group
      title="Sous-titres"
      badge={
        <Badge tone={urls.length > 0 ? 'success' : 'info'}>
          {urls.length > 0 ? plural(urls.length, 'extension') : 'Aucune'}
        </Badge>
      }
      description="Cherchées pendant la lecture quand vous ouvrez le menu des sous-titres, ou d’office si la langue de sous-titres préférée manque dans le fichier. OpenSubtitles v3 est gratuite et sans clé ; d’autres extensions compatibles (SubDL, Subsource…) s’ajoutent par leur lien d’installation."
    >
      <Field label="Adresses des extensions" description="Une adresse de manifeste par ligne.">
        <textarea
          value={text}
          onChange={(event) => update(event.target.value)}
          rows={Math.min(5, Math.max(2, text.split('\n').length))}
          placeholder={OPENSUBTITLES_V3}
          spellCheck={false}
          className="input resize-y font-mono text-xs"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="glass"
          icon={<Server className="size-4" />}
          loading={test.isPending}
          disabled={urls.length === 0}
          onClick={() => test.mutate({ subtitleAddonUrls: urls, providers: ['addons'] })}
        >
          Tester les extensions
        </Button>
        {!urls.includes(OPENSUBTITLES_V3) && (
          <Button
            size="sm"
            variant="glass"
            onClick={() => update([...urls, OPENSUBTITLES_V3].join('\n'))}
          >
            Ajouter OpenSubtitles v3
          </Button>
        )}
      </div>
      <ProviderResults test={test} />
    </Group>
  );
}

/** Compte et clé d'API OpenSubtitles.com (sous-titres faits pour le fichier exact). */
function OpenSubtitlesGroup({
  response,
  username,
  onUsernameChange,
  apiKey,
  onApiKeyChange,
  password,
  onPasswordChange,
}: {
  response: SettingsResponse;
  username: string;
  onUsernameChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
}) {
  const test = useTestSubtitles();
  const hasKey = response.openSubtitlesApiKeyConfigured || apiKey.trim() !== '';
  return (
    <Group
      title="OpenSubtitles.com"
      badge={
        response.openSubtitlesApiKeyConfigured ? (
          <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
            Clé configurée{response.openSubtitlesApiKeyFromEnv ? ' (variable d’environnement)' : ''}
          </Badge>
        ) : (
          <Badge tone="info">Facultatif</Badge>
        )
      }
      description={
        <>
          Sous-titres faits pour votre fichier exact (empreinte du fichier). Créez une clé gratuite
          dans votre compte, rubrique{' '}
          <a
            href="https://www.opensubtitles.com/consumers"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand-300 underline underline-offset-2"
          >
            API consumers
          </a>
          . Sans compte, le nombre de téléchargements par jour est réduit.
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={response.openSubtitlesApiKeyConfigured ? 'Remplacer la clé' : 'Clé d’API'}>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="••••••••••••"
            autoComplete="off"
          />
        </Field>
        <Field label="Identifiant (facultatif)">
          <Input
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label={
            response.openSubtitlesPasswordConfigured ? 'Remplacer le mot de passe' : 'Mot de passe'
          }
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder={response.openSubtitlesPasswordConfigured ? '••••••••' : ''}
            autoComplete="new-password"
          />
        </Field>
      </div>
      <div>
        <Button
          size="sm"
          variant="glass"
          loading={test.isPending}
          disabled={!hasKey}
          onClick={() =>
            test.mutate({
              openSubtitlesApiKey: apiKey.trim() || undefined,
              openSubtitlesUsername: username,
              openSubtitlesPassword: password || undefined,
              providers: ['opensubtitles'],
            })
          }
        >
          Tester la clé et le compte
        </Button>
      </div>
      <ProviderResults test={test} />
    </Group>
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
      description="Titres importés des listes de TMDB (populaires, tendances, à l’affiche, mieux notés) et gardés localement ; la recherche couvre tout TMDB. Leurs fichiers viennent des extensions Stremio."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {system.data?.catalog.map((section) => (
          <div key={section.kind} className="rounded-[1rem] bg-white/[0.05] p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{section.kind === 'movie' ? 'Films' : 'Séries'}</span>
              <div className="flex items-center gap-1.5">
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
            </div>
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
