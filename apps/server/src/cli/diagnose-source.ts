/**
 * Diagnostic de Lumière : vérifie l'extension Stremio qui fournit les liens des fichiers
 * (manifeste, liens d'un film, lecture des premiers octets), et, sur demande, l'accès direct
 * aux pages du site (filtrage Cloudflare, en-têtes, empreinte réseau).
 *
 *   npm run diagnose
 *   npm run diagnose -- --extension=URL      (manifeste à tester, sinon celui des Paramètres)
 *   npm run diagnose -- --film=tt1677720     (film à demander, identifiant IMDb)
 *   npm run diagnose -- --serie=tt0903747:1:1  (demande aussi un épisode : saison 1, épisode 1)
 *   npm run diagnose -- --site               (teste aussi l'accès direct à a.111477.xyz)
 *   npm run diagnose -- --site https://a.111477.xyz/tvs/
 *
 * Chaque demande de liens consomme des jetons de la réserve de l'extension (un par lien
 * proposé chez 111477) : le diagnostic n'en fait qu'une par défaut.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, loadEnvFile, type AppConfig } from '../config/env';
import { errorMessage } from '../core/errors';
import { createLogger } from '../core/logger';
import { silenceSqliteExperimentalWarning } from '../core/warnings';
import { KeyValueCache, openDatabase } from '../infra/database/database';
import { DEFAULT_USER_AGENT, SettingsService } from '../modules/settings/settings.service';
import { parseListing } from '../modules/source/listing-parser';
import { SourceClient } from '../modules/source/source-client';
import {
  StremioAddon,
  contentIdFor,
  normalizeAddonUrl,
  type AddonResult,
} from '../modules/source/stremio/stremio-addon';
import {
  BrowserTransport,
  CookieJar,
  StandardTransport,
  browserHeaders,
  describeRefusal,
  type SourceResponse,
} from '../modules/source/transport';

interface Attempt {
  label: string;
  status: number | null;
  ok: boolean;
  summary: string;
  headers: Record<string, string | null>;
  entries: number;
  ms: number;
}

interface Fetched {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
  url: string;
}

const DEFAULT_SITE_URL = 'https://a.111477.xyz/movies/';
const DEFAULT_MOVIE = 'tt1677720'; // Ready Player One (2018)
const TIMEOUT_MS = 25_000;

function keyHeaders(headers: Headers): Record<string, string | null> {
  return {
    server: headers.get('server'),
    'cf-ray': headers.get('cf-ray'),
    'cf-mitigated': headers.get('cf-mitigated'),
    'content-type': headers.get('content-type'),
  };
}

async function read(response: SourceResponse): Promise<Fetched> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: await response.text(),
    url: response.url,
  };
}

async function evaluate(label: string, url: URL, run: () => Promise<Fetched>): Promise<Attempt> {
  const started = Date.now();
  try {
    const result = await run();
    const ms = Date.now() - started;
    if (result.status >= 200 && result.status < 300) {
      const parsed = parseListing(
        result.body,
        new URL(result.url || url),
        result.headers.get('content-type'),
      );
      return {
        label,
        status: result.status,
        ok: parsed.items.length > 0,
        summary:
          parsed.items.length > 0
            ? `${parsed.items.length} entrées reconnues (format ${parsed.format})`
            : `page reçue mais aucune entrée reconnue (${result.body.length} octets)`,
        headers: keyHeaders(result.headers),
        entries: parsed.items.length,
        ms,
      };
    }
    const diagnosis = describeRefusal(
      result.status,
      result.statusText,
      result.headers,
      result.body.slice(0, 4000),
    );
    return {
      label,
      status: result.status,
      ok: false,
      summary:
        diagnosis.message +
        (diagnosis.details.title ? ` — page « ${diagnosis.details.title} »` : ''),
      headers: keyHeaders(result.headers),
      entries: 0,
      ms,
    };
  } catch (error) {
    return {
      label,
      status: null,
      ok: false,
      summary: `échec : ${errorMessage(error)}`,
      headers: {},
      entries: 0,
      ms: Date.now() - started,
    };
  }
}

function print(attempt: Attempt, indent = ''): void {
  console.log(`${indent}${attempt.ok ? '✔' : '✘'} ${attempt.label}`);
  console.log(`${indent}    ${attempt.status ?? '—'} · ${attempt.summary} · ${attempt.ms} ms`);
  const shown = Object.entries(attempt.headers).filter(([, value]) => value);
  if (shown.length > 0)
    console.log(`${indent}    ${shown.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
}

/** curl du système (Windows 10+, macOS, Linux) : une autre pile TLS, utile pour comparer. */
function runCurl(url: URL): Promise<Fetched> {
  const args = ['-sS', '-L', '--compressed', '--max-time', String(TIMEOUT_MS / 1000), '-D', '-'];
  for (const [name, value] of Object.entries(
    browserHeaders(DEFAULT_USER_AGENT, { kind: 'document' }),
  )) {
    if (name === 'accept-encoding') continue;
    args.push('-H', `${name}: ${value}`);
  }
  args.push(url.toString());
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', () => reject(new Error('curl introuvable sur cette machine')));
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8');
      // Avec -L, plusieurs blocs d'en-têtes peuvent précéder le corps : on garde le dernier.
      const blocks = output.split(/\r?\n\r?\n/);
      let index = 0;
      while (index + 1 < blocks.length && /^HTTP\/[\d.]+ \d{3}/.test(blocks[index + 1] ?? ''))
        index += 1;
      const head = blocks[index] ?? '';
      const body = blocks.slice(index + 1).join('\n\n');
      const statusLine = /^HTTP\/[\d.]+ (\d{3})\s*(.*)$/m.exec(head);
      if (!statusLine) {
        reject(new Error(stderr.trim() || `curl a échoué (code ${code})`));
        return;
      }
      const headers = new Headers();
      for (const line of head.split(/\r?\n/).slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0)
          headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
      resolve({
        status: Number(statusLine[1]),
        statusText: statusLine[2]?.trim() ?? '',
        headers,
        body,
        url: url.toString(),
      });
    });
  });
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

interface ProbeResult {
  label: string;
  line: string;
  /** Le fichier a été servi (2xx, pas une page HTML). */
  ok: boolean;
}

async function probe(label: string, run: () => Promise<SourceResponse>): Promise<ProbeResult> {
  try {
    const response = await run();
    const ok = response.ok && !/text\/html/i.test(response.headers.get('content-type') ?? '');
    return { label, line: await summarize(response), ok };
  } catch (error) {
    return { label, line: `échec : ${errorMessage(error)}`, ok: false };
  }
}

function option(args: string[], name: string): string | null {
  const flag = args.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3).trim() || null : null;
}

/** Manifeste à tester : option --extension=, sinon celui des Paramètres, sinon le défaut. */
function addonUrlFrom(args: string[], config: AppConfig): string {
  const flag = option(args, 'extension');
  if (flag) return flag;
  if (fs.existsSync(config.databaseFile)) {
    const db = openDatabase(config.databaseFile, createLogger({ level: 'silent', pretty: false }));
    try {
      return new SettingsService(db, config).get().stremioAddonUrl;
    } finally {
      db.close();
    }
  }
  return config.defaults.stremioAddonUrl;
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

function printFiles(result: AddonResult): void {
  for (const file of result.files.slice(0, 5)) {
    console.log(`      · ${file.fileName} (${formatSize(file.size)})`);
    if (file.label) console.log(`        ${file.label.slice(0, 140)}`);
  }
  if (result.files.length > 5) console.log(`      · … et ${result.files.length - 5} autre(s)`);
  if (result.notice) console.log(`    message de l’extension : ${result.notice}`);
}

interface AddonReport {
  manifest: boolean;
  configurationRequired: boolean;
  links: number | null;
  limited: boolean;
  bytes: boolean | null;
}

async function diagnoseAddon(args: string[], config: AppConfig): Promise<AddonReport> {
  const report: AddonReport = {
    manifest: false,
    configurationRequired: false,
    links: null,
    limited: false,
    bytes: null,
  };
  const input = addonUrlFrom(args, config);
  let manifestUrl: string;
  try {
    manifestUrl = normalizeAddonUrl(input);
  } catch (error) {
    console.log(`✘ A. adresse d’extension invalide : ${errorMessage(error)}`);
    return report;
  }
  if (!manifestUrl) {
    console.log('— A. extension Stremio : désactivée (Paramètres → Extensions et API)');
    return report;
  }
  console.log(`A. Extension Stremio : ${manifestUrl}`);

  // Base en mémoire : le diagnostic ne touche pas au cache de l'application.
  const silent = createLogger({ level: 'silent', pretty: false });
  const memory = openDatabase(':memory:', silent);
  try {
    const settings = new SettingsService(memory, config);
    await settings.update({ stremioAddonUrl: manifestUrl });
    const addon = new StremioAddon(settings, new KeyValueCache(memory), silent);
    const source = new SourceClient(settings, silent, { addon });

    let started = Date.now();
    let manifest;
    try {
      manifest = await addon.manifest();
    } catch (error) {
      console.log(`✘ A1. manifeste : ${errorMessage(error)} · ${Date.now() - started} ms`);
      return report;
    }
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
      `✔ A1. manifeste : « ${manifest.name} » v${manifest.version} · ressources : ${resources.join(', ') || '—'} · types : ${manifest.types.join(', ') || '—'} · préfixes : ${prefixes.join(', ') || 'tous'} · ${Date.now() - started} ms`,
    );
    if (report.configurationRequired) {
      console.log(
        '    l’extension demande à être configurée : collez son lien d’installation personnalisé.',
      );
    }

    const movie = option(args, 'film') ?? DEFAULT_MOVIE;
    const movieId = contentIdFor(manifest, { imdb: movie, tmdb: null }) ?? movie;
    console.log(
      `… A2. liens du film ${movieId} (consomme des jetons de la réserve de l’extension)`,
    );
    started = Date.now();
    let result: AddonResult;
    try {
      result = await addon.files({ kind: 'movie', id: movieId });
    } catch (error) {
      console.log(`✘ A2. ${errorMessage(error)} · ${Date.now() - started} ms`);
      return report;
    }
    report.links = result.files.length;
    report.limited = result.limited;
    console.log(
      `${result.files.length > 0 ? '✔' : '✘'} A2. ${result.files.length} fichier(s) proposé(s) · ${Date.now() - started} ms`,
    );
    printFiles(result);

    const first = result.files[0];
    if (first) {
      const link = await addon.resolve(first.path).catch(() => null);
      if (link) console.log(`    lien : ${hostOf(link.url)}`);
      started = Date.now();
      const bytes = await probe('A3. lecture du lien (octets 0-1023)', () =>
        source.openFile(first.path, { start: 0, end: 1023 }),
      );
      report.bytes = bytes.ok;
      console.log(
        `${bytes.ok ? '✔' : '✘'} ${bytes.label} : ${bytes.line} · ${Date.now() - started} ms`,
      );
    }

    const episode = option(args, 'serie');
    if (episode) {
      const [id = '', season = '1', number = '1'] = episode.split(':');
      started = Date.now();
      try {
        const series = await addon.files({
          kind: 'series',
          id,
          season: Number(season),
          episode: Number(number),
        });
        console.log(
          `${series.files.length > 0 ? '✔' : '✘'} A4. épisode ${id}:${season}:${number} : ${series.files.length} fichier(s) · ${Date.now() - started} ms`,
        );
        printFiles(series);
      } catch (error) {
        console.log(`✘ A4. épisode ${episode} : ${errorMessage(error)}`);
      }
    }
    return report;
  } finally {
    memory.close();
  }
}

async function diagnoseSite(target: string): Promise<Attempt[]> {
  const url = new URL(target.endsWith('/') ? target : `${target}/`);
  console.log(`\nB. Accès direct au site : ${url.toString()}`);
  const cookies = new CookieJar();
  const standard = new StandardTransport(() => DEFAULT_USER_AGENT, cookies);
  const impersonation = await BrowserTransport.load(new CookieJar());
  const attempts: Attempt[] = [];
  attempts.push(
    await evaluate('B1. fetch minimal', url, async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return read(response);
    }),
  );
  attempts.push(
    await evaluate('B2. requête Node.js + en-têtes de Chrome', url, async () =>
      read(
        await standard.fetch(url.toString(), {
          kind: 'document',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      ),
    ),
  );
  attempts.push(
    impersonation
      ? await evaluate('B3. imitation complète de Chrome (impit)', url, async () =>
          read(
            await impersonation.fetch(url.toString(), {
              kind: 'document',
              signal: AbortSignal.timeout(TIMEOUT_MS),
            }),
          ),
        )
      : {
          label: 'B3. imitation complète de Chrome (impit)',
          status: null,
          ok: false,
          summary: 'module impit indisponible (relancez « npm install »)',
          headers: {},
          entries: 0,
          ms: 0,
        },
  );
  attempts.push(await evaluate('B4. curl du système', url, () => runCurl(url)));
  for (const attempt of attempts) print(attempt);
  return attempts;
}

async function main(): Promise<void> {
  silenceSqliteExperimentalWarning();
  const args = process.argv.slice(2);
  console.log('Diagnostic de Lumière');
  console.log(`Node.js ${process.version} — ${process.platform} ${process.arch}\n`);

  loadEnvFile();
  const config = loadConfig();
  const addon = await diagnoseAddon(args, config);

  const siteTarget = args.find((arg) => !arg.startsWith('--'));
  const site =
    args.includes('--site') || siteTarget || !addon.manifest
      ? await diagnoseSite(siteTarget ?? DEFAULT_SITE_URL)
      : null;

  console.log('\nConclusion :');
  if (addon.manifest && addon.bytes) {
    console.log(
      '  L’extension Stremio fonctionne : Lumière lui demande les liens des films et des\n  épisodes (catalogue TMDB, clé TMDB nécessaire).',
    );
  } else if (addon.manifest && addon.links && addon.bytes === false) {
    console.log(
      '  L’extension donne des liens mais leur lecture est refusée (voir A3) : envoyez ce\n  rapport complet.',
    );
  } else if (addon.manifest && addon.links === 0) {
    console.log(
      addon.limited
        ? '  L’extension a atteint sa limite de liens : réessayez dans quelques minutes (chez\n  111477, la réserve regagne un lien toutes les 5 minutes).'
        : addon.configurationRequired
          ? '  L’extension doit être configurée : ouvrez sa page de configuration, puis collez le\n  lien d’installation obtenu dans Paramètres → Extensions et API.'
          : '  L’extension répond mais ne propose aucun fichier pour ce film : essayez un autre\n  titre (--film=tt…) ou vérifiez sa configuration.',
    );
  } else if (addon.manifest) {
    console.log('  L’extension répond mais la demande de liens a échoué (voir A2).');
  } else if (site?.some((attempt) => attempt.ok)) {
    console.log(
      '  L’extension est injoignable mais le site répond directement : videz l’adresse de\n  l’extension (Paramètres → Extensions et API) pour lire la liste du site.',
    );
  } else {
    console.log(
      '  Ni l’extension ni le site ne répondent : vérifiez l’adresse de l’extension\n  (Paramètres → Extensions et API) et votre connexion, puis envoyez ce rapport complet.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
