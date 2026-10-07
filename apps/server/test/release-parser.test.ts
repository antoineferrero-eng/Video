import { describe, expect, it } from 'vitest';
import { parseEpisode, parseSeasonFolder } from '../src/domain/episode-parser';
import { guessSubtitleLanguage } from '../src/domain/media-files';
import { parseRelease } from '../src/domain/release-parser';
import { parseFolderTitle } from '../src/domain/title-parser';
import { prettifyTitle, searchTokens } from '../src/core/text';

describe('parseRelease', () => {
  it('analyse une release WEB-DL MULTi', () => {
    const result = parseRelease('100.Meters.2025.1080p.NF.WEB-DL.MULTi.DDP5.1.H.264-VARYG.mkv');
    expect(result.title).toBe('100 Meters');
    expect(result.year).toBe(2025);
    expect(result.info).toEqual({
      resolution: '1080p',
      source: 'WEB-DL',
      videoCodec: 'H.264',
      audioCodec: 'DD+ 5.1',
      hdr: null,
      languages: ['MULTi'],
      service: 'Netflix',
      edition: null,
      group: 'VARYG',
    });
  });

  it('analyse une release UHD Remux HDR', () => {
    const result = parseRelease(
      'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GRP.mkv',
    );
    expect(result.title).toBe('Dune Part Two');
    expect(result.year).toBe(2024);
    expect(result.info.resolution).toBe('2160p');
    expect(result.info.source).toBe('Remux');
    expect(result.info.videoCodec).toBe('H.265');
    expect(result.info.hdr).toBe('Dolby Vision · HDR10');
    expect(result.info.audioCodec).toBe('TrueHD Atmos 7.1');
  });

  it('gère les titres contenant une année', () => {
    expect(parseRelease('Blade.Runner.2049.2017.1080p.BluRay.x264.mkv')).toMatchObject({
      title: 'Blade Runner 2049',
      year: 2017,
    });
    expect(parseRelease('2001.A.Space.Odyssey.1968.REMASTERED.1080p.mkv')).toMatchObject({
      title: '2001 A Space Odyssey',
      year: 1968,
    });
  });

  it('reconnaît les tags de langue français', () => {
    expect(parseRelease('Film.2019.TRUEFRENCH.720p.HDLight.x264.AC3-XYZ.mkv').info).toMatchObject({
      languages: ['TRUEFRENCH'],
      source: 'HDLight',
      audioCodec: 'DD',
      resolution: '720p',
    });
    expect(parseRelease('Serie.S02E05.VOSTFR.1080p.WEB.x265.mkv').info.languages).toEqual([
      'VOSTFR',
    ]);
    expect(parseRelease('Film.2021.MULTi.VFF.2160p.10bit.HDR.WEB.mkv').info.languages).toEqual([
      'MULTi',
      'VFF',
    ]);
  });

  it('ne confond pas le titre avec la partie technique', () => {
    expect(parseRelease('Mad.Max.Fury.Road.2015.1080p.mkv').info.service).toBeNull();
    expect(parseRelease('Simple Movie.mp4')).toMatchObject({ title: 'Simple Movie', year: null });
  });
});

describe('parseEpisode', () => {
  it.each([
    ['Show.S01E02.1080p.mkv', null, { season: 1, episode: 2, episodeEnd: null }],
    ['Show.S01E02E03.mkv', null, { season: 1, episode: 2, episodeEnd: 3 }],
    ['Show.S01E02-E03.mkv', null, { season: 1, episode: 2, episodeEnd: 3 }],
    ['Show s3e10 720p.mkv', null, { season: 3, episode: 10, episodeEnd: null }],
    ['Show.1x05.mkv', null, { season: 1, episode: 5, episodeEnd: null }],
    ['Show Saison 2 Episode 7.mkv', null, { season: 2, episode: 7, episodeEnd: null }],
    ['Episode 12.mkv', 4, { season: 4, episode: 12, episodeEnd: null }],
    ['Show - 03 [1080p].mkv', 1, { season: 1, episode: 3, episodeEnd: null }],
    ['Movie.2020.1080p.mkv', null, { season: null, episode: null, episodeEnd: null }],
  ])('%s', (name, fallback, expected) => {
    expect(parseEpisode(name, fallback)).toEqual(expected);
  });
});

describe('parseSeasonFolder', () => {
  it.each([
    ['Season 1', 1],
    ['Saison 02', 2],
    ['S03', 3],
    ['season.4', 4],
    ['Show Name Season 5', 5],
    ['Show.S06.1080p.WEB', 6],
    ['Specials', 0],
    ['7', 7],
    ['Extras Behind The Scenes', null],
  ])('%s → %s', (name, expected) => {
    expect(parseSeasonFolder(name)).toBe(expected);
  });
});

describe('parseFolderTitle', () => {
  it.each([
    ['100 METERS (2025)', { title: '100 Meters', year: 2025 }],
    ['Amélie (2001)', { title: 'Amélie', year: 2001 }],
    ['The Office (US) (2005)', { title: 'The Office (US)', year: 2005 }],
    ['Breaking Bad', { title: 'Breaking Bad', year: null }],
    ['Oppenheimer.2023.1080p.BluRay.x264-GRP', { title: 'Oppenheimer', year: 2023 }],
    ['THE LORD OF THE RINGS II [2002]', { title: 'The Lord Of The Rings II', year: 2002 }],
  ])('%s', (name, expected) => {
    expect(parseFolderTitle(name)).toEqual(expected);
  });
});

describe('utilitaires texte', () => {
  it('met en forme les titres en majuscules', () => {
    expect(prettifyTitle("L'ÂGE DE GLACE")).toBe("L'Âge De Glace");
    expect(prettifyTitle('Déjà en minuscules')).toBe('Déjà en minuscules');
  });

  it('tokenise une recherche sans accents ni mots vides', () => {
    expect(searchTokens('Le Fabuleux Destin d’Amélie')).toEqual(['fabuleux', 'destin', 'amelie']);
  });

  it('devine la langue des sous-titres', () => {
    expect(guessSubtitleLanguage('Movie.2020.1080p.fr.srt')).toBe('fr');
    expect(guessSubtitleLanguage('Movie.2020.English.srt')).toBe('en');
    expect(guessSubtitleLanguage('Movie.srt')).toBeNull();
  });
});
