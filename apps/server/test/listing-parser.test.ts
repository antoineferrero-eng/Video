import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseListing } from '../src/modules/source/listing-parser';

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'listings', name), 'utf8');

const GiB = 1024 ** 3;

describe('parseListing', () => {
  it('analyse un autoindex nginx (<pre>, tailles exactes)', () => {
    const result = parseListing(fixture('nginx.html'), new URL('https://a.example.xyz/movies/'));
    expect(result.format).toBe('pre');
    expect(result.items).toEqual([
      {
        name: '100 METERS (2025)',
        isDirectory: true,
        size: null,
        modifiedAt: '2025-10-07T09:12:00.000Z',
      },
      {
        name: 'Amélie (2001)',
        isDirectory: true,
        size: null,
        modifiedAt: '2024-03-15T18:03:00.000Z',
      },
      {
        name: 'The Matrix (1999)',
        isDirectory: true,
        size: null,
        modifiedAt: '2023-01-01T00:00:00.000Z',
      },
      {
        name: 'Some.Very.Long.Release.Name.2020.1080p.WEB-DL.MULTi.DDP5.1.H.264-GROUP.mkv',
        isDirectory: false,
        size: 2 * GiB,
        modifiedAt: '2020-02-02T10:20:00.000Z',
      },
      {
        name: 'readme.txt',
        isDirectory: false,
        size: 1234,
        modifiedAt: '2020-02-02T10:21:00.000Z',
      },
    ]);
  });

  it('analyse un autoindex nginx avec tailles « humaines »', () => {
    const result = parseListing(
      fixture('nginx-humansize.html'),
      new URL('https://a.example.xyz/tvs/Show/Season%201/'),
    );
    expect(result.items.map((item) => [item.name, item.size])).toEqual([
      ['Show.S01E01.1080p.WEB.H264-GRP.mkv', Math.round(1.4 * GiB)],
      ['Show.S01E02.1080p.WEB.H264-GRP.mkv', 734 * 1024 ** 2],
      ['Show.S01E02.1080p.WEB.H264-GRP.fr.srt', 52 * 1024],
    ]);
  });

  it('analyse un tableau Apache avec en-têtes', () => {
    // L'URL de la page n'a pas de slash final (redirection Apache) : on doit quand même trouver les enfants.
    const result = parseListing(fixture('apache.html'), new URL('https://host.test/movies'));
    expect(result.format).toBe('table');
    expect(result.items).toEqual([
      {
        name: 'Inception (2010)',
        isDirectory: true,
        size: null,
        modifiedAt: '2025-09-30T21:45:00.000Z',
      },
      {
        name: 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos.7.1-GRP.mkv',
        isDirectory: false,
        size: 61 * GiB,
        modifiedAt: '2025-10-01T08:00:00.000Z',
      },
    ]);
  });

  it('analyse un listing Caddy (liens « ./ », <time datetime>)', () => {
    const result = parseListing(fixture('caddy.html'), new URL('https://host.test/tvs/'));
    expect(result.format).toBe('table');
    expect(result.items).toEqual([
      {
        name: 'Breaking Bad',
        isDirectory: true,
        size: null,
        modifiedAt: '2025-08-01T10:00:00.000Z',
      },
      {
        name: 'Les Revenants',
        isDirectory: true,
        size: null,
        modifiedAt: '2024-02-11T08:30:00.000Z',
      },
      { name: 'notes.txt', isDirectory: false, size: 2048, modifiedAt: '2024-02-11T08:31:00.000Z' },
    ]);
  });

  it('analyse une grille <div> personnalisée et ignore la navigation', () => {
    const result = parseListing(fixture('custom-grid.html'), new URL('https://host.test/movies/'));
    expect(result.items).toEqual([
      {
        name: 'Oppenheimer (2023)',
        isDirectory: true,
        size: null,
        modifiedAt: '2025-10-03T16:05:00.000Z',
      },
      {
        name: 'Barbie.2023.1080p.WEBRip.x265.mp4',
        isDirectory: false,
        size: Math.round(1.5 * GiB),
        modifiedAt: '2025-10-03T16:05:00.000Z',
      },
      {
        name: 'Past Lives (2023)',
        isDirectory: true,
        size: null,
        modifiedAt: '2025-09-12T00:00:00.000Z',
      },
    ]);
  });

  it('analyse une liste <ul> (python http.server) et ignore les fichiers cachés', () => {
    const result = parseListing(fixture('list.html'), new URL('https://host.test/movies/'));
    expect(result.format).toBe('list');
    expect(result.items.map((item) => [item.name, item.isDirectory])).toEqual([
      ["Le Fabuleux Destin d'Amélie Poulain (2001)", true],
      ['clip.webm', false],
    ]);
  });

  it('analyse un listing JSON (nginx autoindex_format json)', () => {
    const result = parseListing(
      fixture('nginx.json'),
      new URL('https://host.test/tvs/'),
      'application/json',
    );
    expect(result.format).toBe('json');
    expect(result.items).toEqual([
      { name: 'Severance', isDirectory: true, size: null, modifiedAt: '2025-10-07T09:12:00.000Z' },
      {
        name: 'pilot.mkv',
        isDirectory: false,
        size: 104857600,
        modifiedAt: '2025-10-08T10:00:00.000Z',
      },
    ]);
  });

  it('ignore les liens externes, parents et de tri', () => {
    const html = `<a href="../">..</a><a href="?C=N;O=D">Name</a><a href="https://evil.test/x/">x</a>
      <a href="/other/">other</a><a href="/movies/">self</a><a href="sub/deep/">deep</a><a href="ok/">ok</a>`;
    const result = parseListing(html, new URL('https://host.test/movies/'));
    expect(result.items.map((item) => item.name)).toEqual(['ok']);
  });
});
