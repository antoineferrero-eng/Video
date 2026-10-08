/**
 * Lance une démonstration complète hors ligne :
 *  1. génère les vidéos d'exemple si besoin ;
 *  2. démarre la source de démonstration (http://127.0.0.1:8585) ;
 *  3. démarre Lumière avec une base de données dédiée (data/demo) : catalogue du faux TMDB,
 *     fichiers fournis par la fausse extension Stremio (comme avec 111477).
 *
 *   npm run demo          (depuis la racine du dépôt, après « npm run build » pour l'interface)
 *   DEMO_MODE=listing npm run demo   (liste de la source lue directement, sans extension)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from './server';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const contentRoot = path.resolve(here, '../content');
const port = Number(process.env.DEMO_PORT ?? 8585);

if (!fs.existsSync(path.join(contentRoot, 'movies'))) {
  console.log('Génération des vidéos de démonstration…');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(here, 'generate-media.ts')],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

createDemoServer({
  root: contentRoot,
  port,
  host: '127.0.0.1',
  throttleKbps: Number(process.env.DEMO_THROTTLE_KBPS ?? 4096),
  maxConnections: Number(process.env.DEMO_MAX_CONNECTIONS ?? 0),
}).listen(port, '127.0.0.1', () => {
  console.log(`Source de démonstration : http://127.0.0.1:${port}/`);
  const server = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'apps/server/src/main.ts')],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        SOURCE_BASE_URL: `http://127.0.0.1:${port}`,
        DATA_DIR: process.env.DATA_DIR ?? path.join(repoRoot, 'data', 'demo'),
        // Fausse extension Stremio (ou liste de la source avec DEMO_MODE=listing).
        STREMIO_ADDON_URL:
          process.env.DEMO_MODE === 'listing'
            ? ''
            : `http://127.0.0.1:${port}/stremio/manifest.json`,
        // Faux TMDB de la démonstration (les titres d'exemple sont fictifs).
        TMDB_API_KEY: 'demo',
        TMDB_API_BASE_URL: `http://127.0.0.1:${port}/tmdb/3`,
        TMDB_IMAGE_BASE_URL: `http://127.0.0.1:${port}/tmdb-images`,
        // Faux OpenSubtitles (clé « demo », compte demo / demo) et fausse extension de sous-titres.
        OPENSUBTITLES_API_KEY: process.env.OPENSUBTITLES_API_KEY ?? 'demo',
        OPENSUBTITLES_API_URL: `http://127.0.0.1:${port}/opensubtitles/api/v1`,
        SUBTITLE_ADDON_URLS: `http://127.0.0.1:${port}/subtitles-addon/manifest.json`,
      },
    },
  );
  const stop = () => {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (code) => process.exit(code ?? 0));
});
