import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger';
import { openDatabase, type Db } from '../src/infra/database/database';
import {
  TitlesRepository,
  type TitleMetadata,
  type TmdbTitleUpsert,
} from '../src/modules/catalog/titles.repository';

const silent = createLogger({ level: 'silent', pretty: false });

function upsert(tmdbId: number, title: string, popularity: number | null): TmdbTitleUpsert {
  return {
    kind: 'movie',
    tmdbId,
    title,
    originalTitle: null,
    year: 2024,
    releaseDate: '2024-01-01',
    overview: `Résumé de ${title}`,
    posterPath: null,
    backdropPath: `/b${tmdbId}.jpg`,
    rating: 7,
    voteCount: 100,
    popularity,
    genres: [],
    language: 'fr-FR',
    remotePath: `/movies/${title} (2024)/`,
    folderName: `${title} (2024)`,
  };
}

describe('tri par popularité', () => {
  let db: Db;
  let titles: TitlesRepository;
  const order = () =>
    titles
      .search({ kind: 'movie', tokens: [], sort: 'popular', limit: 50, offset: 0 })
      .rows.map((row) => row.parsed_title);

  beforeEach(() => {
    db = openDatabase(':memory:', silent);
    titles = new TitlesRepository(db);
    titles.upsertTmdb(upsert(1, 'Ancien succès', 900));
    titles.upsertTmdb(upsert(2, 'En tête', 300));
    titles.upsertTmdb(upsert(3, 'Second', 120));
    titles.upsertTmdb(upsert(4, 'Sans données', null));
  });

  afterEach(() => db.close());

  it('classe du plus populaire au moins populaire, les inconnus à la fin', () => {
    expect(order()).toEqual(['Ancien succès', 'En tête', 'Second', 'Sans données']);
    expect(titles.popular('movie', 10).map((row) => row.parsed_title)).toEqual([
      'Ancien succès',
      'En tête',
      'Second',
    ]);
    expect(titles.hasPopularity('movie')).toBe(true);
    expect(titles.hasPopularity('series')).toBe(false);
  });

  it('fait passer une popularité ancienne après les valeurs à jour', () => {
    // Succès sorti des listes TMDB depuis des semaines : sa valeur n'est plus actualisée.
    db.prepare(
      "UPDATE titles SET popularity_at = '2020-01-01T00:00:00.000Z' WHERE tmdb_id = 1",
    ).run();
    expect(order()).toEqual(['En tête', 'Second', 'Ancien succès', 'Sans données']);
    expect(titles.featured(2).map((row) => row.parsed_title)).toEqual(['En tête', 'Second']);

    // Revu dans une liste TMDB : sa popularité est de nouveau à jour.
    expect(titles.setPopularity('movie', 1, 50)).toBe(1);
    expect(order()).toEqual(['En tête', 'Second', 'Ancien succès', 'Sans données']);
    expect(titles.setPopularity('movie', 1, 500)).toBe(1);
    expect(order()[0]).toBe('Ancien succès');
  });

  it('met à jour un titre déjà connu à chaque import des listes TMDB', () => {
    // Auparavant, cette mise à jour échouait en silence (paramètres nommés en trop).
    expect(titles.upsertTmdb({ ...upsert(3, 'Second', 2000), rating: 8.4 })).not.toBeNull();
    const row = titles.findByTmdbId('movie', 3);
    expect(row?.popularity).toBe(2000);
    expect(row?.rating).toBe(8.4);
    expect(order()[0]).toBe('Second');
  });

  it('garde la popularité connue quand une source n’en fournit pas', () => {
    const row = titles.findByTmdbId('movie', 3);
    const metadata: TitleMetadata = {
      status: 'matched',
      language: 'fr-FR',
      tmdbId: 3,
      tmdbTitle: 'Second',
      originalTitle: null,
      overview: null,
      tagline: null,
      posterPath: null,
      backdropPath: null,
      rating: null,
      voteCount: null,
      popularity: null,
      genres: [],
      runtime: null,
      releaseDate: null,
      metaSearchText: null,
    };
    titles.updateMetadata(row!.id, metadata);
    expect(titles.findById(row!.id)?.popularity).toBe(120);
    titles.upsertTmdb(upsert(3, 'Second', null));
    expect(titles.findById(row!.id)?.popularity).toBe(120);
    titles.updateMetadata(row!.id, { ...metadata, popularity: 450 });
    expect(order()[1]).toBe('Second');
  });
});
