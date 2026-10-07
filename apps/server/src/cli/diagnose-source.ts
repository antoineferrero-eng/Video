/**
 * Diagnostic de connexion à la source : essaie plusieurs façons de télécharger une page de
 * listing et explique pourquoi la source refuse (filtrage Cloudflare, en-têtes, empreinte).
 * Si aucune requête directe ne passe, la vérification Cloudflare est tentée dans le
 * navigateur de l'utilisateur (une fenêtre s'ouvre).
 *
 *   npm run diagnose
 *   npm run diagnose -- https://a.111477.xyz/tvs/
 *   npm run diagnose -- --zenrows=CLÉ          (clé ZenRows, sinon celle des Paramètres)
 *   npm run diagnose -- --dossier=URL          (dossier d'un titre, si la liste complète échoue)
 *   npm run diagnose -- --navigateur           (essaie aussi la vérification dans le navigateur)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, loadEnvFile, type AppConfig } from '../config/env';
import { createLogger } from '../core/logger';
import { errorMessage } from '../core/errors';
import { BrowserSession, type Clearance } from '../modules/source/browser/browser-session';
import { locateBrowser } from '../modules/source/browser/locate-browser';
import { RealBrowserTransport } from '../modules/source/browser/real-browser-transport';
import { parseListing, type ListingItem } from '../modules/source/listing-parser';
import { openDatabase } from '../infra/database/database';
import { DEFAULT_CDN } from '../modules/source/cdn-transport';
import { DEFAULT_USER_AGENT, SettingsService } from '../modules/settings/settings.service';
import { ZenRowsTransport } from '../modules/source/zenrows-transport';
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

const DEFAULT_URL = 'https://a.111477.xyz/movies/';
const TIMEOUT_MS = 25_000;
const VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts)$/i;

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

function listingOf(result: Fetched, url: URL): ListingItem[] {
  return parseListing(result.body, new URL(result.url || url), result.headers.get('content-type'))
    .items;
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

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function describeClearance(clearance: Clearance, ms: number): string {
  const names = clearance.cookies.map((cookie) => cookie.name).join(', ') || 'aucun';
  const validity = clearance.expiresAt
    ? `cf_clearance valable ${Math.round((clearance.expiresAt - Date.now()) / 60_000)} min (jusqu'à ${formatTime(clearance.expiresAt)})`
    : 'pas de cookie cf_clearance';
  return `passée en ${Math.round(ms / 1000)} s · cookies : ${names} · ${validity}`;
}

/** Premier fichier vidéo trouvé dans les premiers dossiers du listing (pour tester les fichiers). */
async function findVideo(
  items: ListingItem[],
  base: URL,
  list: (url: URL) => Promise<Fetched>,
  maxFolders = 3,
): Promise<URL | null> {
  const direct = items.find((item) => !item.isDirectory && VIDEO.test(item.name));
  if (direct) return new URL(encodeURIComponent(direct.name), base);
  for (const folder of items.filter((item) => item.isDirectory).slice(0, maxFolders)) {
    const folderUrl = new URL(`${encodeURIComponent(folder.name)}/`, base);
    const result = await list(folderUrl).catch(() => null);
    if (!result || result.status !== 200) continue;
    const video = listingOf(result, folderUrl).find(
      (item) => !item.isDirectory && VIDEO.test(item.name),
    );
    if (video) return new URL(encodeURIComponent(video.name), folderUrl);
  }
  return null;
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

/** Clé ZenRows : option --zenrows=, variable ZENROWS_API_KEY, ou celle des Paramètres. */
function zenrowsKeyFrom(args: string[], config: AppConfig): string | null {
  const flag = args.find((arg) => arg.startsWith('--zenrows='));
  if (flag) return flag.slice('--zenrows='.length).trim() || null;
  if (config.zenrows.envApiKey) return config.zenrows.envApiKey;
  if (!fs.existsSync(config.databaseFile)) return null;
  const db = openDatabase(config.databaseFile, createLogger({ level: 'silent', pretty: false }));
  try {
    return new SettingsService(db, config).getZenrowsApiKey();
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceBrowser = args.includes('--navigateur');
  const target = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_URL;
  const url = new URL(target.endsWith('/') ? target : `${target}/`);
  console.log(`Diagnostic de connexion à ${url.toString()}`);
  console.log(`Node.js ${process.version} — ${process.platform} ${process.arch}\n`);

  loadEnvFile();
  const config = loadConfig();
  const cookies = new CookieJar();
  const standard = new StandardTransport(() => DEFAULT_USER_AGENT, cookies);
  const impersonation = await BrowserTransport.load(new CookieJar());

  const attempts: Attempt[] = [];
  attempts.push(
    await evaluate('1. fetch minimal (ancienne version)', url, async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return read(response);
    }),
  );
  attempts.push(
    await evaluate('2. requête Node.js + en-têtes de Chrome', url, async () =>
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
      ? await evaluate('3. imitation complète de Chrome (impit)', url, async () =>
          read(
            await impersonation.fetch(url.toString(), {
              kind: 'document',
              signal: AbortSignal.timeout(TIMEOUT_MS),
            }),
          ),
        )
      : {
          label: '3. imitation complète de Chrome (impit)',
          status: null,
          ok: false,
          summary: 'module impit indisponible (relancez « npm install »)',
          headers: {},
          entries: 0,
          ms: 0,
        },
  );
  attempts.push(await evaluate('4. curl du système', url, () => runCurl(url)));
  for (const attempt of attempts) print(attempt);

  const directOk = attempts.some((attempt) => attempt.ok);
  const silent = createLogger({ level: 'silent', pretty: false });
  const is111477 = DEFAULT_CDN.hosts.test(url.hostname);
  let fileUrl: URL | null = null;

  // Z. Pages de listing via ZenRows (service en ligne), si une clé est disponible.
  const zenrowsKey = zenrowsKeyFrom(args, config);
  let viaZenRows: Attempt | null = null;
  let titleFolder: Attempt | null = null;
  console.log('');
  if (zenrowsKey) {
    const zenrows = new ZenRowsTransport(() => zenrowsKey, config.zenrows.apiUrl, silent);
    let page: Fetched | null = null;
    viaZenRows = await evaluate('Z. pages de listing via ZenRows', url, async () => {
      page = await read(
        await zenrows.fetch(url.toString(), {
          kind: 'document',
          signal: AbortSignal.timeout(180_000),
        }),
      );
      return page;
    });
    print(viaZenRows);
    for (const attempt of zenrows.lastAttempts) {
      const credits = attempt.credits !== null ? ` · ${attempt.credits} crédit(s)` : '';
      const error = attempt.error ? ` · ${attempt.error}` : '';
      console.log(
        `    · ${attempt.strategy} : ${attempt.status}${credits}${error} · ${attempt.ms} ms`,
      );
    }
    const viaZenRowsFetch = async (target: URL) =>
      read(
        await zenrows.fetch(target.toString(), {
          kind: 'document',
          signal: AbortSignal.timeout(180_000),
        }),
      );
    if (viaZenRows.ok && page) {
      // Un seul dossier exploré pour trouver un fichier : chaque page coûte des crédits.
      fileUrl = await findVideo(listOfItems(page, url), url, viaZenRowsFetch, 1);
    } else {
      // Liste complète illisible (trop volumineuse…) : le catalogue TMDB n'a besoin que du
      // dossier de chaque titre. On en essaie un.
      const flag = args.find((arg) => arg.startsWith('--dossier='))?.slice('--dossier='.length);
      const folder = flag
        ? new URL(flag.endsWith('/') ? flag : `${flag}/`)
        : is111477
          ? new URL('/movies/Ready%20Player%20One%20(2018)/', url.origin)
          : null;
      if (folder) {
        let folderPage: Fetched | null = null;
        titleFolder = await evaluate(
          `Z2. dossier d’un titre via ZenRows (${decodeURIComponent(folder.pathname)})`,
          folder,
          async () => {
            folderPage = await viaZenRowsFetch(folder);
            return folderPage;
          },
        );
        print(titleFolder);
        if (titleFolder.ok && folderPage)
          fileUrl = await findVideo(listOfItems(folderPage, folder), folder, viaZenRowsFetch, 1);
      }
    }
    console.log(`    crédits ZenRows utilisés par ce diagnostic : ${zenrows.usage().credits}`);
  } else {
    console.log(
      '— Z. ZenRows : aucune clé (Paramètres → Source, variable ZENROWS_API_KEY ou --zenrows=CLÉ)',
    );
  }

  // 5. Vérification Cloudflare dans le navigateur de l'utilisateur (sur demande).
  const executable = locateBrowser(config.browserPath);
  let verified: Clearance | null = null;
  let reuse: Attempt | null = null;
  let pageAttempt: Attempt | null = null;
  if (forceBrowser) {
    console.log('');
    if (!executable) {
      console.log('✘ 5. votre navigateur : aucun Chrome, Edge, Brave ou Chromium trouvé');
      console.log('    (installez-en un, ou indiquez son chemin avec la variable BROWSER_PATH)');
    } else {
      console.log(`… 5. votre navigateur (${executable.name}) : vérification Cloudflare`);
      console.log(
        '    Une fenêtre va s’ouvrir sur le site. Si une case « Je suis humain » apparaît, cochez-la.',
      );
      const session = new BrowserSession({
        profileDir: config.browserProfileDir,
        locate: () => executable,
        logger: silent,
        onEvent: (event) => {
          if (event.state === 'waiting') console.log(`    ${event.message}`);
        },
      });
      const started = Date.now();
      try {
        verified = await session.verify(url.origin);
        console.log(`✔ 5. vérification ${describeClearance(verified, Date.now() - started)}`);
        console.log(`    navigateur : ${verified.userAgent}`);
        const transport = new RealBrowserTransport(session, new CookieJar(), silent);
        reuse = await evaluate(
          '5a. passage réutilisé hors du navigateur (impit + cookies)',
          url,
          async () => {
            const response = await transport.fetchWithClearance(
              url.toString(),
              { kind: 'document' },
              verified as Clearance,
            );
            if (!response) throw new Error('module impit indisponible');
            return read(response);
          },
        );
        print(reuse, '  ');
        let listed: Fetched | null = null;
        pageAttempt = await evaluate(
          '5b. requête faite depuis la page du navigateur',
          url,
          async () => {
            listed = await read(
              await session.pageFetch(url.origin, url.toString(), { kind: 'document' }),
            );
            return listed;
          },
        );
        print(pageAttempt, '  ');
        if (!fileUrl && pageAttempt.ok && listed) {
          fileUrl = await findVideo(listOfItems(listed, url), url, async (folder) =>
            read(await session.pageFetch(url.origin, folder.toString(), { kind: 'document' })),
          );
        }
      } catch (error) {
        console.log(`✘ 5. ${errorMessage(error)}`);
      } finally {
        await session.close();
      }
    }
  } else if (!directOk) {
    console.log('— 5. votre navigateur : non essayé (ajoutez --navigateur pour l’essayer)');
  }

  // F. Téléchargement direct d'un vrai fichier (sans ZenRows) : passe-t-il Cloudflare ?
  const files: ProbeResult[] = [];
  if (fileUrl) {
    const file = fileUrl;
    const name = decodeURIComponent(file.pathname.split('/').pop() ?? '');
    console.log(`\nF. téléchargement direct de « ${name} » (octets 0-1023) :`);
    const range = { kind: 'file' as const, range: 'bytes=0-1023' };
    files.push(
      await probe('F1. Node.js + en-têtes de Chrome', () =>
        standard.fetch(file.toString(), { ...range, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      ),
    );
    if (impersonation) {
      files.push(
        await probe('F2. imitation de Chrome', () =>
          impersonation.fetch(file.toString(), {
            ...range,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        ),
      );
    }
    if (is111477) {
      const cdn = new URL(DEFAULT_CDN.baseUrl);
      cdn.searchParams.set('u', file.toString());
      files.push(
        await probe('F3. point d’accès de lecture p.111477.xyz', async () =>
          (impersonation ?? standard).fetch(cdn.toString(), {
            ...range,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        ),
      );
    }
    for (const result of files)
      console.log(`  ${result.ok ? '✔' : '✘'} ${result.label} : ${result.line}`);
  }

  // 6–7. Services annexes de 111477 : lecteur (p.) et extension Stremio (st.).
  if (is111477 && impersonation) {
    console.log('');
    const imitate = (target: string) =>
      impersonation.fetch(target, { kind: 'document', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const probes = [
      await probe('6a. p.111477.xyz/', () => imitate('https://p.111477.xyz/')),
      await probe('6b. p.111477.xyz/bulk?u=<dossier>', () =>
        imitate(`https://p.111477.xyz/bulk?u=${encodeURIComponent(url.toString())}`),
      ),
      await probe('7. st.111477.xyz/manifest.json', async () => {
        const response = await imitate('https://st.111477.xyz/manifest.json');
        if (!response.ok) return response;
        const manifest = JSON.parse(await response.text()) as {
          name?: string;
          version?: string;
          resources?: Array<string | { name: string }>;
          types?: string[];
          catalogs?: unknown[];
        };
        const resources = (manifest.resources ?? []).map((entry) =>
          typeof entry === 'string' ? entry : entry.name,
        );
        return new Response(
          `« ${manifest.name ?? '?'} » v${manifest.version ?? '?'} · ressources : ${resources.join(', ') || '—'} · types : ${(manifest.types ?? []).join(', ') || '—'} · catalogues : ${manifest.catalogs?.length ?? 0}`,
          { status: response.status, headers: { 'content-type': 'text/plain' } },
        ) as unknown as SourceResponse;
      }),
    ];
    for (const result of probes) console.log(`${result.label} : ${result.line}`);
  }

  const [, headers, impersonated] = attempts;
  const directFile = files.some((result) => result.ok && !result.label.startsWith('F3'));
  const cdnFile = files.some((result) => result.ok && result.label.startsWith('F3'));
  console.log('\nConclusion :');
  if (headers?.ok) {
    console.log(
      attempts[0]?.ok
        ? '  La source répond normalement : Lumière fonctionne en mode « Automatique ».'
        : "  Il suffisait d'envoyer les en-têtes d'un navigateur : c'est ce que fait Lumière.",
    );
  } else if (impersonated?.ok) {
    console.log(
      "  La source filtre l'empreinte réseau des clients : Lumière bascule automatiquement sur\n  l'imitation de Chrome (mode « Automatique » ou « Imitation de navigateur »).",
    );
  } else if (viaZenRows?.ok || titleFolder?.ok) {
    if (!viaZenRows?.ok) {
      console.log(
        '  La liste complète est illisible via ZenRows (trop volumineuse pour l’offre ?), mais le\n  dossier d’un titre passe : le catalogue TMDB (Paramètres → Catalogue → « Automatique » ou\n  « TMDB ») fonctionnera, avec une clé TMDB.',
      );
    }
    if (directFile) {
      console.log(
        '  Les pages passent par ZenRows et les fichiers se téléchargent directement : choisissez\n  « ZenRows » (ou « Automatique ») dans Paramètres → Source.',
      );
    } else if (cdnFile) {
      console.log(
        '  Les pages passent par ZenRows ; les liens directs sont bloqués mais p.111477.xyz sert\n  les fichiers : Lumière s’en sert automatiquement (dans la limite de ses jetons).',
      );
    } else if (!fileUrl) {
      console.log(
        '  Les pages passent par ZenRows (aucun fichier trouvé pour tester le téléchargement).',
      );
    } else {
      console.log(
        '  Les pages passent par ZenRows mais les fichiers restent bloqués (lien direct et\n  p.111477.xyz) : envoyez ce rapport complet.',
      );
    }
  } else if (zenrowsKey) {
    console.log(
      '  ZenRows n’a pas obtenu la page : voir le détail « Z » ci-dessus (clé, crédits,\n  configuration) et envoyez ce rapport complet.',
    );
  } else if (reuse?.ok) {
    console.log(
      '  Cloudflare exige une vérification de navigateur : Lumière la fait passer par votre\n  navigateur, puis travaille seul avec ce passage (mode « Automatique »).',
    );
  } else if (pageAttempt?.ok) {
    console.log(
      '  Cloudflare n’accepte que le navigateur lui-même : Lumière fera ses requêtes depuis une\n  fenêtre réduite de votre navigateur (mode « Automatique »).',
    );
  } else if (verified) {
    console.log(
      '  La vérification passe dans le navigateur mais les requêtes restent refusées :\n  envoyez ce rapport complet.',
    );
  } else {
    console.log(
      '  Cloudflare exige une vérification que les requêtes directes ne passent pas : ajoutez\n  une clé ZenRows (Paramètres → Source) puis relancez « npm run diagnose ».',
    );
  }
}

function listOfItems(result: Fetched, url: URL): ListingItem[] {
  return result.status === 200 ? listingOf(result, url) : [];
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
