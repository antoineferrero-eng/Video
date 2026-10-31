import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { createLogger } from '../src/core/logger';
import { openDatabase } from '../src/infra/database/database';
import { MIGRATIONS } from '../src/infra/database/migrations';
import { SettingsService } from '../src/modules/settings/settings.service';

const silent = createLogger({ level: 'silent', pretty: false });
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Base à l'état d'avant une migration, remplie par `seed`, puis rouverte (migration appliquée). */
function migrateFrom(before: number, seed: (db: ReturnType<typeof openDatabase>) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-migration-'));
  dirs.push(dir);
  const file = path.join(dir, 'lumiere.db');
  const old = openDatabase(
    file,
    silent,
    MIGRATIONS.filter((migration) => migration.id < before),
  );
  seed(old);
  old.close();
  return openDatabase(file, silent);
}

describe('migration vers les extensions Stremio seules', () => {
  it('reprend l’extension enregistrée et oublie les réglages de l’ancienne source', () => {
    const db = migrateFrom(6, (old) => {
      const set = old.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
      set.run('stremioAddonUrl', JSON.stringify('https://mon.addon/cfg/manifest.json'), 'x');
      set.run('sourceBaseUrl', JSON.stringify('https://a.111477.xyz'), 'x');
      set.run('catalogSource', JSON.stringify('listing'), 'x');
      set.run('preferredQuality', JSON.stringify('720p'), 'x');
    });
    const settings = new SettingsService(db, loadConfig({}));
    expect(settings.get().stremioAddonUrls).toEqual(['https://mon.addon/cfg/manifest.json']);
    expect(settings.get().preferredQuality).toBe('720p');
    const keys = (db.prepare('SELECT key FROM settings').all() as Array<{ key: string }>).map(
      (row) => row.key,
    );
    expect(keys.sort()).toEqual(['preferredQuality', 'stremioAddonUrls']);
    db.close();
  });

  it('remplace une extension désactivée par celle par défaut', () => {
    const db = migrateFrom(6, (old) => {
      old
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('stremioAddonUrl', JSON.stringify(''), 'x');
    });
    expect(new SettingsService(db, loadConfig({})).get().stremioAddonUrls).toEqual([
      'https://st.111477.xyz/manifest.json',
    ]);
    db.close();
  });
});

describe('migration de la source loadix.fun', () => {
  it('ouvre la recherche de loadix au lieu de sa page d’accueil', () => {
    const sources = [
      { id: 'a', name: 'loadix.fun', searchUrl: 'https://loadix.fun/', host: '1fichier' },
      { id: 'b', name: 'Autre', searchUrl: 'https://autre.site/?q={titre}', host: '1fichier' },
    ];
    const db = migrateFrom(9, (old) => {
      old
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('customSources', JSON.stringify(sources), 'x');
    });
    expect(new SettingsService(db, loadConfig({})).get().customSources).toEqual([
      { ...sources[0], searchUrl: 'https://loadix.fun/search?q={titre}&type={type_en}' },
      sources[1],
    ]);
    db.close();
  });
});
