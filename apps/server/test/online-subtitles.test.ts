import { describe, expect, it } from 'vitest';
import { sniffSubtitleFormat } from '../src/modules/playback/subtitles';
import {
  rank,
  type OnlineSubtitleCandidate,
} from '../src/modules/subtitles/online-subtitles.service';
import { openSubtitlesHash } from '../src/modules/subtitles/opensubtitles-hash';
import { numericImdbId, searchParams } from '../src/modules/subtitles/opensubtitles.client';
import { providesSubtitles, subtitlesUrl } from '../src/modules/subtitles/subtitle-addons';

/** Octets pseudo-aléatoires reproductibles (mêmes valeurs que la référence Python). */
function bytes(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let x = 42;
  for (let index = 0; index < size; index += 1) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    buffer[index] = (x >> 16) & 0xff;
  }
  return buffer;
}

const reader = (data: Buffer) => async (start: number, length: number) =>
  data.subarray(start, start + length);

describe('empreinte OpenSubtitles', () => {
  it('correspond à l’algorithme de référence', async () => {
    // Valeurs calculées par une implémentation Python indépendante (struct « <Q »).
    for (const [size, expected] of [
      [200_000, '817670c12d232df0'],
      [65_536, '3e75f8a446b459d8'],
      [100_003, 'af6d99e2612ba82c'],
    ] as const) {
      const data = bytes(size);
      expect(await openSubtitlesHash(size, reader(data))).toBe(expected);
    }
  });

  it('ne calcule rien pour un fichier trop petit ou de taille inconnue', async () => {
    expect(await openSubtitlesHash(1000, reader(bytes(1000)))).toBeNull();
    expect(await openSubtitlesHash(null, reader(bytes(10)))).toBeNull();
  });
});

describe('API OpenSubtitles', () => {
  const base = {
    tmdbId: null,
    languages: ['fr', 'en'],
    hash: null,
    query: null,
  };

  it('envoie des paramètres triés, l’IMDb sans « tt » et la série pour un épisode', () => {
    expect(numericImdbId('tt0063350')).toBe('63350');
    expect(numericImdbId('tmdb:12')).toBeNull();
    expect(
      searchParams({
        ...base,
        kind: 'movie',
        imdbId: 'tt1677720',
        season: null,
        episode: null,
        hash: '8e245d9679d31e12',
      }).toString(),
    ).toBe('imdb_id=1677720&languages=en%2Cfr&moviehash=8e245d9679d31e12&type=movie');
    expect(
      searchParams({
        ...base,
        kind: 'series',
        imdbId: 'tt0903747',
        season: 1,
        episode: 3,
      }).toString(),
    ).toBe('episode_number=3&languages=en%2Cfr&parent_imdb_id=903747&season_number=1&type=episode');
  });

  it('cherche un épisode sans numéros par le nom du fichier, pas par la série', () => {
    const params = searchParams({
      ...base,
      kind: 'series',
      imdbId: 'tt0903747',
      season: null,
      episode: null,
      query: 'Breaking.Bad.Special',
    });
    expect(params.has('imdb_id')).toBe(false);
    expect(params.has('parent_imdb_id')).toBe(false);
    expect(params.get('query')).toBe('breaking.bad.special');
  });

  it('se rabat sur TMDB, puis sur le nom du fichier', () => {
    expect(
      searchParams({
        ...base,
        kind: 'movie',
        imdbId: null,
        tmdbId: 333339,
        season: null,
        episode: null,
      }).get('tmdb_id'),
    ).toBe('333339');
    expect(
      searchParams({
        ...base,
        kind: 'movie',
        imdbId: null,
        season: null,
        episode: null,
        query: 'Ready.Player.One.2018.1080p',
      }).get('query'),
    ).toBe('ready.player.one.2018.1080p');
  });
});

describe('extensions Stremio de sous-titres', () => {
  const manifest = {
    id: 'x',
    name: 'OpenSubtitles v3',
    version: '1.0.0',
    types: ['movie', 'series'],
    resources: ['subtitles'],
    idPrefixes: ['tt'],
  };

  it('reconnaît les extensions de sous-titres', () => {
    expect(providesSubtitles(manifest, 'movie', 'tt1')).toBe(true);
    expect(providesSubtitles(manifest, 'series', 'tmdb:1')).toBe(false);
    expect(providesSubtitles({ ...manifest, resources: ['stream'] }, 'movie', 'tt1')).toBe(false);
    expect(
      providesSubtitles(
        { ...manifest, resources: [{ name: 'subtitles', types: ['movie'] }] },
        'series',
        'tt1',
      ),
    ).toBe(false);
  });

  it('passe l’empreinte, la taille et le nom du fichier en arguments', () => {
    expect(
      subtitlesUrl('https://opensubtitles-v3.strem.io/manifest.json', {
        kind: 'series',
        imdbId: 'tt0903747',
        season: 1,
        episode: 3,
        hash: 'abc',
        size: 1234,
        fileName: 'Breaking Bad S01E03.mkv',
      }),
    ).toBe(
      'https://opensubtitles-v3.strem.io/subtitles/series/tt0903747%3A1%3A3/filename=Breaking+Bad+S01E03.mkv&videoHash=abc&videoSize=1234.json',
    );
    expect(
      subtitlesUrl('https://x.example/cfg/manifest.json', {
        kind: 'movie',
        imdbId: 'tt1',
        season: null,
        episode: null,
        hash: null,
        size: null,
        fileName: null,
      }),
    ).toBe('https://x.example/cfg/subtitles/movie/tt1.json');
  });
});

describe('classement des sous-titres en ligne', () => {
  const candidate = (
    key: string,
    overrides: Partial<OnlineSubtitleCandidate>,
  ): OnlineSubtitleCandidate => ({
    key,
    provider: 'OpenSubtitles',
    language: 'fr',
    release: null,
    downloads: 0,
    hashMatch: false,
    hearingImpaired: false,
    forced: false,
    ref: { provider: 'addon', url: `https://x/${key}` },
    ...overrides,
  });

  it('langue préférée, fichier exact, puis complets et plus téléchargés ; sans doublon', () => {
    const ranked = rank(
      [
        candidate('en', { language: 'en', downloads: 9999 }),
        candidate('popular', { downloads: 5000 }),
        candidate('exact', { hashMatch: true, downloads: 3 }),
        candidate('forced', { forced: true, downloads: 9000 }),
        candidate('popular', { downloads: 5000 }),
        candidate('de', { language: 'de' }),
        candidate('addon', { downloads: null }),
      ],
      ['fr', 'en'],
    );
    expect(ranked.map((item) => item.key)).toEqual(['exact', 'popular', 'addon', 'forced', 'en']);
  });
});

describe('format des sous-titres', () => {
  it('reconnaît WebVTT, ASS et SubRip', () => {
    expect(sniffSubtitleFormat('﻿WEBVTT\n\n00:01.000 --> 00:02.000\nx')).toBe('vtt');
    expect(sniffSubtitleFormat('  [Script Info]\nTitle: x')).toBe('ass');
    expect(sniffSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nx')).toBe('srt');
  });
});
