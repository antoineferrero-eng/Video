/**
 * Outil de diagnostic : affiche ce que l'analyseur comprend d'une page de listing.
 *
 *   npm run probe -w @lumiere/server -- https://a.111477.xyz/movies/
 */
import { parseListing } from '../modules/source/listing-parser';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage : npm run probe -w @lumiere/server -- <url-du-dossier>');
    process.exit(1);
  }
  const url = new URL(target.endsWith('/') ? target : `${target}/`);
  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
  });
  const body = await response.text();
  console.log(
    `HTTP ${response.status} — ${body.length} octets en ${Date.now() - started} ms (${response.url})`,
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
