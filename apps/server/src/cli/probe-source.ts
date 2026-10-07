/**
 * Outil de diagnostic : affiche ce que l'analyseur comprend d'une page de listing.
 *
 *   npm run probe -w @lumiere/server -- https://a.111477.xyz/movies/
 */
import { DEFAULT_USER_AGENT } from '../modules/settings/settings.service';
import { parseListing } from '../modules/source/listing-parser';
import {
  BrowserTransport,
  CookieJar,
  StandardTransport,
  looksBlocked,
  type SourceResponse,
} from '../modules/source/transport';

/** Même stratégie que le mode « Automatique » : requête standard, puis imitation de Chrome. */
async function download(url: URL): Promise<{ response: SourceResponse; via: string }> {
  const cookies = new CookieJar();
  const standard = new StandardTransport(() => DEFAULT_USER_AGENT, cookies);
  const response = await standard.fetch(url.toString(), { kind: 'document' });
  if (!looksBlocked(response)) return { response, via: 'connexion standard' };
  const browser = await BrowserTransport.load(cookies);
  if (!browser) return { response, via: 'connexion standard (impit indisponible)' };
  await response.body?.cancel();
  return {
    response: await browser.fetch(url.toString(), { kind: 'document' }),
    via: 'imitation de Chrome',
  };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage : npm run probe -w @lumiere/server -- <url-du-dossier>');
    process.exit(1);
  }
  const url = new URL(target.endsWith('/') ? target : `${target}/`);
  const started = Date.now();
  const { response, via } = await download(url);
  const body = await response.text();
  console.log(
    `HTTP ${response.status} — ${body.length} octets en ${Date.now() - started} ms (${response.url}, ${via})`,
  );
  const parsed = parseListing(
    body,
    new URL(response.url || url),
    response.headers.get('content-type'),
  );
  console.log(`Format détecté : ${parsed.format} — ${parsed.items.length} entrées`);
  console.table(
    parsed.items.slice(0, 30).map((item) => ({
      nom: item.name,
      dossier: item.isDirectory,
      taille: item.size,
      modifié: item.modifiedAt,
    })),
  );
  if (parsed.items.length === 0) {
    console.log('\nAperçu du HTML reçu :\n');
    console.log(body.slice(0, 2000));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
