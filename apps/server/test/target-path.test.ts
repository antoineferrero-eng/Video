import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../src/core/fs';
import { buildTargetPath } from '../src/modules/downloads/target-path';
import { normalizeRemotePath } from '../src/modules/source/remote-path';

const root = path.resolve('/media');

describe('buildTargetPath', () => {
  it('range les films dans Films/<dossier du titre>', () => {
    expect(
      buildTargetPath(root, {
        kind: 'movie',
        remotePath: '/movies/100 METERS (2025)/100.Meters.2025.mkv',
        fileName: '100.Meters.2025.mkv',
        titleFolder: '100 METERS (2025)',
        season: null,
      }),
    ).toBe(path.join(root, 'Films', '100 METERS (2025)', '100.Meters.2025.mkv'));
  });

  it('range les épisodes par saison', () => {
    expect(
      buildTargetPath(root, {
        kind: 'episode',
        remotePath: '/tvs/Show/Season 1/Show.S01E02.mkv',
        fileName: 'Show.S01E02.mkv',
        titleFolder: 'Show',
        season: 1,
      }),
    ).toBe(path.join(root, 'Séries', 'Show', 'Saison 01', 'Show.S01E02.mkv'));
  });

  it("reproduit l'arborescence distante pour les autres fichiers", () => {
    expect(
      buildTargetPath(root, {
        kind: 'file',
        remotePath: '/misc/a:b/clip?.mp4',
        fileName: 'clip?.mp4',
        titleFolder: null,
        season: null,
      }),
    ).toBe(path.join(root, 'Autres', 'misc', 'a b', 'clip .mp4'));
  });
});

describe('sécurité des chemins', () => {
  it('nettoie les noms de fichiers', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('  a/b\\c:d*?.  ')).toBe('a b c d');
    expect(sanitizeFileName('..')).toBe('sans-titre');
  });

  it('refuse les remontées de dossier dans les chemins distants', () => {
    expect(() => normalizeRemotePath('/movies/../etc/passwd')).toThrow();
    expect(normalizeRemotePath('movies//Film (2020)/')).toBe('/movies/Film (2020)/');
  });
});
