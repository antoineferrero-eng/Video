/**
 * Diagnostic de connexion à la source : essaie plusieurs façons de télécharger une page de
 * listing et explique pourquoi la source refuse (filtrage Cloudflare, en-têtes, empreinte).
 *
 *   npm run diagnose
 *   npm run diagnose -- https://a.111477.xyz/tvs/
 */
import { spawn } from 'node:child_process';
import { parseListing } from '../modules/source/listing-parser';
import { DEFAULT_USER_AGENT } from '../modules/settings/settings.service';
import {
  BrowserTransport,
  CookieJar,
  StandardTransport,
  browserHeaders,
  describeRefusal,
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

const DEFAULT_URL = 'https://a.111477.xyz/movies/';
const TIMEOUT_MS = 25_000;

function keyHeaders(headers: Headers): Record<string, string | null> {
  return {
    server: headers.get('server'),
    'cf-ray': headers.get('cf-ray'),
    'cf-mitigated': headers.get('cf-mitigated'),
    'content-type': headers.get('content-type'),
  };
}

async function evaluate(
  label: string,
  url: URL,
  run: () => Promise<{
    status: number;
    statusText: string;
    headers: Headers;
    body: string;
    url: string;
  }>,
): Promise<Attempt> {
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
      summary: `échec : ${error instanceof Error ? error.message : String(error)}`,
      headers: {},
      entries: 0,
      ms: Date.now() - started,
    };
  }
}

/** curl du système (Windows 10+, macOS, Linux) : une autre pile TLS, utile pour comparer. */
function runCurl(
  url: URL,
): Promise<{ status: number; statusText: string; headers: Headers; body: string; url: string }> {
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

async function main(): Promise<void> {
  const target = process.argv[2] ?? DEFAULT_URL;
  const url = new URL(target.endsWith('/') ? target : `${target}/`);
  console.log(`Diagnostic de connexion à ${url.toString()}`);
  console.log(`Node.js ${process.version} — ${process.platform} ${process.arch}\n`);

  const cookies = new CookieJar();
  const standard = new StandardTransport(() => DEFAULT_USER_AGENT, cookies);
  const browser = await BrowserTransport.load(new CookieJar());

  const attempts: Attempt[] = [];
  attempts.push(
    await evaluate('1. fetch minimal (ancienne version)', url, async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: await response.text(),
        url: response.url,
      };
    }),
  );
  attempts.push(
    await evaluate('2. requête Node.js + en-têtes de Chrome', url, async () => {
      const response = await standard.fetch(url.toString(), {
        kind: 'document',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: await response.text(),
        url: response.url,
      };
    }),
  );
  attempts.push(
    browser
      ? await evaluate('3. imitation complète de Chrome (impit)', url, async () => {
          const response = await browser.fetch(url.toString(), {
            kind: 'document',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          return {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: await response.text(),
            url: response.url,
          };
        })
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

  for (const attempt of attempts) {
    console.log(`${attempt.ok ? '✔' : '✘'} ${attempt.label}`);
    console.log(`    ${attempt.status ?? '—'} · ${attempt.summary} · ${attempt.ms} ms`);
    const shown = Object.entries(attempt.headers).filter(([, value]) => value);
    if (shown.length > 0)
      console.log(`    ${shown.map(([name, value]) => `${name}: ${value}`).join(' | ')}`);
  }

  const [minimal, headers, impersonation, curl] = attempts;
  console.log('\nConclusion :');
  if (headers?.ok) {
    console.log(
      minimal?.ok
        ? '  La source répond normalement : Lumière fonctionne en mode « Automatique ».'
        : "  Il suffisait d'envoyer les en-têtes d'un navigateur : c'est ce que fait désormais Lumière.",
    );
  } else if (impersonation?.ok) {
    console.log(
      "  La source filtre l'empreinte réseau des clients : Lumière bascule automatiquement sur\n  l'imitation de Chrome (mode « Automatique » ou « Imitation de navigateur »).",
    );
  } else if (curl?.ok) {
    console.log('  Seul curl passe : envoyez ce rapport pour adapter Lumière à cette source.');
  } else {
    console.log(
      "  Aucune méthode n'aboutit : la source impose sans doute une vérification que seul un\n  navigateur peut passer, ou bloque cette adresse IP. Envoyez ce rapport complet.",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
