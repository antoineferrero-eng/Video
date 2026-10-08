import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFile } from '../src/config/env';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.LUMIERE_TEST_FROM_FILE;
  delete process.env.LUMIERE_TEST_PRIORITY;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('configuration', () => {
  it('applique les valeurs par défaut', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ host: '127.0.0.1', port: 8484, logLevel: 'info' });
    expect(config.defaults.stremioAddonUrls).toEqual(['https://st.111477.xyz/manifest.json']);
    expect(config.tmdb.envApiKey).toBeNull();
  });

  it('résout les chemins relatifs depuis le dossier de lancement', () => {
    const dir = tempDir();
    const config = loadConfig({
      INIT_CWD: dir,
      DATA_DIR: 'donnees',
    });
    expect(config.dataDir).toBe(path.join(dir, 'donnees'));
    expect(config.databaseFile).toBe(path.join(dir, 'donnees', 'lumiere.db'));
    expect(config.defaults.downloadDir).toBe(path.join(dir, 'donnees', 'media'));
    expect(loadConfig({ INIT_CWD: dir, MEDIA_DIR: 'videos' }).defaults.downloadDir).toBe(
      path.join(dir, 'videos'),
    );
  });

  it('refuse une configuration invalide avec un message explicite', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Configuration invalide[\s\S]*PORT/);
    expect(() => loadConfig({ TMDB_API_BASE_URL: 'pas une url' })).toThrow(/TMDB_API_BASE_URL/);
  });

  it('lit plusieurs extensions Stremio, ou l’ancienne variable à une seule adresse', () => {
    expect(
      loadConfig({ STREMIO_ADDON_URLS: 'https://a.example/manifest.json, https://b.example' })
        .defaults.stremioAddonUrls,
    ).toEqual(['https://a.example/manifest.json', 'https://b.example']);
    expect(
      loadConfig({ STREMIO_ADDON_URL: 'https://c.example/manifest.json' }).defaults
        .stremioAddonUrls,
    ).toEqual(['https://c.example/manifest.json']);
    expect(loadConfig({ STREMIO_ADDON_URLS: '' }).defaults.stremioAddonUrls).toEqual([]);
  });

  it('charge le fichier .env sans écraser les variables déjà définies', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'LUMIERE_TEST_FROM_FILE=fichier\nLUMIERE_TEST_PRIORITY=fichier\n',
    );
    process.env.LUMIERE_TEST_PRIORITY = 'environnement';

    expect(loadEnvFile({ INIT_CWD: dir })).toBe(path.join(dir, '.env'));
    expect(process.env.LUMIERE_TEST_FROM_FILE).toBe('fichier');
    expect(process.env.LUMIERE_TEST_PRIORITY).toBe('environnement');
    expect(loadEnvFile({ INIT_CWD: tempDir() })).toBeNull();
  });
});
