/**
 * Diagnostic de Lumière : vérifie chaque extension Stremio qui fournit les liens des fichiers
 * (manifeste, liens d'un film, lecture des premiers octets).
 *
 *   npm run diagnose
 *   npm run diagnose -- --extension=URL        (extension à tester, répétable ; sinon
 *                                               celles des Paramètres)
 *   npm run diagnose -- --film=tt1677720       (film à demander, identifiant IMDb)
 *   npm run diagnose -- --serie=tt0903747:1:1  (demande aussi un épisode : saison 1, épisode 1)
 *
 * Chaque demande de liens peut consommer des jetons de la réserve d'une extension (un par lien
 * proposé chez 111477) : le diagnostic n'en fait qu'une par extension et par défaut.
 */
import fs from 'node:fs';
import { loadConfig, loadEnvFile, type AppConfig } from '../config/env';
import { errorMessage } from '../core/errors';
import { createLogger } from '../core/logger';
import { silenceSqliteExperimentalWarning } from '../core/warnings';
import { KeyValueCache, openDatabase } from '../infra/database/database';
import { SettingsService } from '../modules/settings/settings.service';
import { SourceClient } from '../modules/source/source-client';
import {
  StremioAddons,
  normalizeAddonUrls,
  type AddonFile,
  type AddonResult,
} from '../modules/source/stremio/stremio-addon';
import type { SourceResponse } from '../modules/source/transport';

const DEFAULT_MOVIE = 'tt1677720'; // Ready Player One (2018)

function option(args: string[], name: string): string | null {
  const flag = args.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3).trim() || null : null;
}

/** Extensions à tester : options --extension=, sinon celles des Paramètres, sinon le défaut. */
function addonUrlsFrom(args: string[], config: AppConfig): string[] {
  const flags = args
    .filter((arg) => arg.startsWith('--extension='))
    .map((arg) => arg.slice('--extension='.length).trim());
  if (flags.length > 0) return flags;
  if (fs.existsSync(config.databaseFile)) {
    const db = openDatabase(config.databaseFile, createLogger({ level: 'silent', pretty: false }));
    try {
      return new SettingsService(db, config).get().stremioAddonUrls;
    } finally {
      db.close();
    }
  }
  return config.defaults.stremioAddonUrls;
}

/** Adresse sans ses paramètres (les liens portent souvent un jeton personnel). */
function hostOf(link: string): string {
  try {
    const url = new URL(link);
    return `${url.protocol}//${url.host}${url.pathname.split('/').slice(0, 2).join('/')}/…`;
  } catch {
    return '?';
  }
}

function formatSize(bytes: number | null): string {
  if (!bytes) return 'taille inconnue';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} Go`
    : `${Math.round(bytes / 1024 ** 2)} Mo`;
}

function printFiles(files: AddonFile[], indent = '      '): void {
  for (const file of files.slice(0, 5)) {
    console.log(`${indent}· ${file.fileName} (${formatSize(file.size)})`);
    if (file.label) console.log(`${indent}  ${file.label.slice(0, 140)}`);
  }
  if (files.length > 5) console.log(`${indent}· … et ${files.length - 5} autre(s)`);
}

/** Résumé d'une réponse (fichier ou page) sans la télécharger entièrement. */
async function summarize(response: SourceResponse): Promise<string> {
  const type = response.headers.get('content-type') ?? '?';
  const range = response.headers.get('content-range');
  const length = response.headers.get('content-length');
  const parts = [`${response.status}`, type];
  if (range) parts.push(range);
  else if (length) parts.push(`${length} octets`);
  if (response.headers.get('cf-mitigated'))
    parts.push(`cf-mitigated: ${response.headers.get('cf-mitigated')}`);
  const reader = response.body?.getReader();
  let preview = '';
  if (reader) {
    const chunk = await reader.read().catch(() => ({ value: undefined }));
    await reader.cancel().catch(() => undefined);
    if (chunk.value && /text|json|html/i.test(type)) {
      const text = Buffer.from(chunk.value).toString('utf8');
      const title = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(text)?.[1]?.trim();
      preview = title ? `page « ${title} »` : text.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  if (preview) parts.push(preview);
  return parts.join(' · ');
}

/** Le fichier a-t-il été servi (2xx, pas une page HTML) ? */
async function probe(run: () => Promise<SourceResponse>): Promise<{ ok: boolean; line: string }> {
  try {
    const response = await run();
    const ok = response.ok && !/text\/html/i.test(response.headers.get('content-type') ?? '');
    return { ok, line: await summarize(response) };
  } catch (error) {
    return { ok: false, line: `échec : ${errorMessage(error)}` };
  }
}

interface AddonReport {
  name: string;
  manifest: boolean;
  configurationRequired: boolean;
  links: number | null;
  limited: boolean;
  bytes: boolean | null;
}

/** Diagnostic d'une extension, seule (ses liens ne sont pas mêlés à ceux des autres). */
async function diagnoseAddon(
  index: number,
  manifestUrl: string,
  args: string[],
  config: AppConfig,
): Promise<AddonReport> {
  const step = String.fromCharCode(65 + index);
  const report: AddonReport = {
    name: manifestUrl,
    manifest: false,
    configurationRequired: false,
    links: null,
    limited: false,
    bytes: null,
  };
  console.log(`\n${step}. Extension : ${manifestUrl}`);

  // Base en mémoire : le diagnostic ne touche pas au cache de l'application.
  const silent = createLogger({ level: 'silent', pretty: false });
  const memory = openDatabase(':memory:', silent);
  try {
    const settings = new SettingsService(memory, config);
    await settings.update({ stremioAddonUrls: [manifestUrl] });
    const addons = new StremioAddons(settings, new KeyValueCache(memory), silent);
    const source = new SourceClient(addons, silent);

    let started = Date.now();
    let manifest;
    try {
      manifest = await addons.manifest(manifestUrl);
    } catch (error) {
      console.log(`✘ ${step}1. manifeste : ${errorMessage(error)} · ${Date.now() - started} ms`);
      return report;
    }
    report.name = manifest.name;
    report.manifest = true;
    report.configurationRequired = manifest.behaviorHints?.configurationRequired === true;
    const resources = manifest.resources.map((entry) =>
      typeof entry === 'string' ? entry : entry.name,
    );
    const prefixes =
      manifest.idPrefixes ??
      manifest.resources.flatMap((entry) =>
        typeof entry === 'object' ? (entry.idPrefixes ?? []) : [],
      );
    console.log(
      `✔ ${step}1. manifeste : « ${manifest.name} » v${manifest.version} · ressources : ${resources.join(', ') || '—'} · types : ${manifest.types.join(', ') || '—'} · préfixes : ${prefixes.join(', ') || 'tous'} · ${Date.now() - started} ms`,
    );
    if (report.configurationRequired) {
      console.log(
        '    l’extension demande à être configurée : collez son lien d’installation personnalisé.',
      );
    }

    const movie = option(args, 'film') ?? DEFAULT_MOVIE;
    console.log(`… ${step}2. liens du film ${movie} (peut consommer des jetons de l’extension)`);
    started = Date.now();
    let result: AddonResult;
    try {
      result = await addons.files({ kind: 'movie', id: movie });
    } catch (error) {
      console.log(`✘ ${step}2. ${errorMessage(error)} · ${Date.now() - started} ms`);
      return report;
    }
    report.links = result.files.length;
    report.limited = result.limited;
    console.log(
      `${result.files.length > 0 ? '✔' : '✘'} ${step}2. ${result.files.length} fichier(s) proposé(s) · ${Date.now() - started} ms`,
    );
    printFiles(result.files);
    if (result.notice) console.log(`    message de l’extension : ${result.notice}`);

    const first = result.files[0];
    if (first) {
      const [link] = await addons.links(first.path).catch(() => []);
      if (link) console.log(`    lien : ${hostOf(link.url)}`);
      started = Date.now();
      const bytes = await probe(() => source.openFile(first.path, { start: 0, end: 1023 }));
      report.bytes = bytes.ok;
      console.log(
        `${bytes.ok ? '✔' : '✘'} ${step}3. lecture du lien (octets 0-1023) : ${bytes.line} · ${Date.now() - started} ms`,
      );
    }

    const episode = option(args, 'serie');
    if (episode) {
      const [id = '', season = '1', number = '1'] = episode.split(':');
      started = Date.now();
      try {
        const series = await addons.files({
          kind: 'series',
          id,
          season: Number(season),
          episode: Number(number),
        });
        console.log(
          `${series.files.length > 0 ? '✔' : '✘'} ${step}4. épisode ${id}:${season}:${number} : ${series.files.length} fichier(s) · ${Date.now() - started} ms`,
        );
        printFiles(series.files);
        if (series.notice) console.log(`    message de l’extension : ${series.notice}`);
      } catch (error) {
        console.log(`✘ ${step}4. épisode ${episode} : ${errorMessage(error)}`);
      }
    }
    return report;
  } finally {
    memory.close();
  }
}

function conclusion(report: AddonReport): string {
  if (!report.manifest) return 'injoignable (adresse, connexion ou extension hors service).';
  if (report.bytes) return 'fonctionne (liens obtenus et lus).';
  if (report.links && report.bytes === false)
    return 'donne des liens mais leur lecture est refusée : envoyez ce rapport complet.';
  if (report.links === 0) {
    if (report.limited)
      return 'a atteint sa limite de liens : réessayez dans quelques minutes (chez 111477, la réserve regagne un lien toutes les 5 minutes).';
    if (report.configurationRequired)
      return 'doit être configurée : ouvrez sa page de configuration, puis collez le lien d’installation obtenu dans Paramètres → Sources.';
    return 'répond mais ne propose aucun fichier pour ce film : essayez un autre titre (--film=tt…) ou vérifiez sa configuration.';
  }
  return 'répond mais la demande de liens a échoué.';
}

async function main(): Promise<void> {
  silenceSqliteExperimentalWarning();
  const args = process.argv.slice(2);
  console.log('Diagnostic de Lumière');
  console.log(`Node.js ${process.version} — ${process.platform} ${process.arch}`);

  loadEnvFile();
  const config = loadConfig();
  let urls: string[];
  try {
    urls = normalizeAddonUrls(addonUrlsFrom(args, config));
  } catch (error) {
    console.log(`\n✘ adresse d’extension invalide : ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }
  if (urls.length === 0) {
    console.log(
      '\n— Aucune extension Stremio configurée : ajoutez-en une dans Paramètres → Sources.',
    );
    return;
  }
  const reports: AddonReport[] = [];
  for (const [index, url] of urls.entries())
    reports.push(await diagnoseAddon(index, url, args, config));

  console.log('\nConclusion :');
  for (const report of reports) console.log(`  « ${report.name} » ${conclusion(report)}`);
  if (reports.some((report) => report.bytes)) {
    console.log(
      '  Lumière demande les liens des films et des épisodes à ces extensions (catalogue TMDB,\n  clé TMDB nécessaire).',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
