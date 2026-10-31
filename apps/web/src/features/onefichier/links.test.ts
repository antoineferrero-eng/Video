import { describe, expect, it } from 'vitest';
import type { CustomSource, TitleDetails } from '@lumiere/shared';
import { LOADIX_SEARCH_URL, customSourceUrl, findOneFichierLink, hasMarkers } from './links';

const title = {
  kind: 'series',
  title: 'Les Années folles',
  originalTitle: 'Roaring Years',
  year: 2024,
  tmdbId: 42,
  imdbId: 'tt0000042',
} as TitleDetails;

describe('sources personnalisées', () => {
  it('ouvre la recherche de loadix sur le titre et le type de la fiche', () => {
    const source: CustomSource = {
      id: 'a',
      name: 'loadix.fun',
      searchUrl: LOADIX_SEARCH_URL,
      host: '1fichier',
    };
    expect(customSourceUrl(source, title)).toBe(
      'https://loadix.fun/search?q=Les%20Ann%C3%A9es%20folles&type=series',
    );
  });

  it('remplace tous les repères et laisse les inconnus', () => {
    const source = {
      id: 'b',
      name: 'Site',
      searchUrl: 'https://site/{type}/{tmdb}?imdb={imdb}&an={annee}&vo={titre_original}&x={autre}',
      host: '1fichier',
    } as const;
    expect(customSourceUrl(source, title)).toBe(
      'https://site/serie/42?imdb=tt0000042&an=2024&vo=Roaring%20Years&x={autre}',
    );
    expect(hasMarkers(source.searchUrl)).toBe(true);
    expect(hasMarkers('https://loadix.fun/')).toBe(false);
  });

  it('trouve un lien 1fichier dans un texte copié', () => {
    expect(findOneFichierLink('Lien : https://1fichier.com/?abcde12345&af=1 !')).toBe(
      'https://1fichier.com/?abcde12345&af=1',
    );
    expect(findOneFichierLink('https://loadix.fun/media/123')).toBeNull();
  });
});
