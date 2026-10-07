import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Considère une variable d'environnement vide comme absente. */
const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8484),
  DATA_DIR: z.string().default('data'),
  MEDIA_DIR: optionalString,
  WEB_DIST_DIR: optionalString,
  SOURCE_BASE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.url({ protocol: /^https?$/ }).default('https://a.111477.xyz'),
  ),
  SOURCE_MOVIES_PATH: z.string().default('/movies/'),
  SOURCE_SERIES_PATH: z.string().default('/tvs/'),
  TMDB_API_KEY: optionalString,
  TMDB_API_BASE_URL: z.url().default('https://api.themoviedb.org/3'),
  TMDB_IMAGE_BASE_URL: z.url().default('https://image.tmdb.org/t/p'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  BROWSER_PATH: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.enum(['auto', 'true', 'false']).default('auto'),
});

export interface AppConfig {
  version: string;
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
  cacheDir: string;
  webDistDir: string;
  defaults: {
    sourceBaseUrl: string;
    moviesPath: string;
    seriesPath: string;
    downloadDir: string;
  };
  tmdb: {
    envApiKey: string | null;
    apiBaseUrl: string;
    imageBaseUrl: string;
  };
  ffmpegPath: string;
  ffprobePath: string;
  /** Navigateur imposé pour les vérifications Cloudflare (sinon recherche automatique). */
  browserPath: string | null;
  /** Profil dédié du navigateur piloté par Lumière. */
  browserProfileDir: string;
  logLevel: string;
  prettyLogs: boolean;
}

/** Dossier de lancement : npm exécute les scripts d'un workspace depuis son propre dossier. */
function launchDir(env: NodeJS.ProcessEnv): string {
  return env.INIT_CWD ?? process.cwd();
}

/**
 * Charge le fichier `.env` du dossier de lancement s'il existe. Les variables déjà
 * définies dans l'environnement restent prioritaires.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = path.join(launchDir(env), '.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  const e = parsed.data;
  // Chemins relatifs résolus depuis le dossier où la commande a été lancée.
  const baseDir = launchDir(env);
  const dataDir = path.resolve(baseDir, e.DATA_DIR);
  // Interface compilée (apps/web/dist), que le serveur tourne depuis le bundle
  // (apps/server/dist/main.js) ou depuis les sources (apps/server/src/config/env.ts).
  const webDistCandidates = ['../../web/dist', '../../../web/dist'].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const defaultWebDist =
    webDistCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) ??
    webDistCandidates.find((candidate) => candidate.endsWith(path.join('apps', 'web', 'dist'))) ??
    (webDistCandidates[0] as string);

  return {
    version: env.npm_package_version ?? '1.0.0',
    host: e.HOST,
    port: e.PORT,
    dataDir,
    databaseFile: path.join(dataDir, 'lumiere.db'),
    cacheDir: path.join(dataDir, 'cache'),
    webDistDir: e.WEB_DIST_DIR ? path.resolve(baseDir, e.WEB_DIST_DIR) : defaultWebDist,
    defaults: {
      sourceBaseUrl: e.SOURCE_BASE_URL.replace(/\/+$/, ''),
      moviesPath: e.SOURCE_MOVIES_PATH,
      seriesPath: e.SOURCE_SERIES_PATH,
      downloadDir: e.MEDIA_DIR ? path.resolve(baseDir, e.MEDIA_DIR) : path.join(dataDir, 'media'),
    },
    tmdb: {
      envApiKey: e.TMDB_API_KEY ?? null,
      apiBaseUrl: e.TMDB_API_BASE_URL.replace(/\/+$/, ''),
      imageBaseUrl: e.TMDB_IMAGE_BASE_URL.replace(/\/+$/, ''),
    },
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    browserPath: e.BROWSER_PATH ? path.resolve(baseDir, e.BROWSER_PATH) : null,
    browserProfileDir: path.join(dataDir, 'navigateur'),
    logLevel: e.LOG_LEVEL,
    prettyLogs: e.LOG_PRETTY === 'auto' ? Boolean(process.stdout.isTTY) : e.LOG_PRETTY === 'true',
  };
}
