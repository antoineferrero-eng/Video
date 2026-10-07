import { describe, expect, it } from 'vitest';
import { folderCandidates, titleVariants } from '../src/domain/folder-names';

describe('noms de dossiers probables', () => {
  it('suit la convention « Titre (Année) » des films, du plus probable au moins probable', () => {
    expect(
      folderCandidates({
        kind: 'movie',
        titles: ['Ready Player One', 'Ready Player One', 'Player One'],
        year: 2018,
      }),
    ).toEqual([
      'Ready Player One (2018)',
      'Player One (2018)',
      'READY PLAYER ONE (2018)',
      'Ready Player One (2017)',
      'Ready Player One (2019)',
    ]);
  });

  it('remplace les caractères interdits comme Radarr et Sonarr', () => {
    expect(titleVariants('Spider-Man: No Way Home')).toEqual([
      'Spider-Man No Way Home',
      'Spider-Man - No Way Home',
      'Spider-Man- No Way Home',
    ]);
    expect(titleVariants('What If...?')).toEqual(['What If', 'What If...!']);
    expect(titleVariants('Your Name.')).toEqual(['Your Name']);
    expect(titleVariants('AC/DC: Live')).toContain('AC+DC Live');
  });

  it('propose « Titre », puis « Titre (Année) » pour une série', () => {
    expect(folderCandidates({ kind: 'series', titles: ['Spider-Noir'], year: 2026 })).toEqual([
      'Spider-Noir',
      'Spider-Noir (2026)',
      'SPIDER-NOIR',
    ]);
  });

  it('ignore les titres sans lettres latines et borne le nombre d’essais', () => {
    const candidates = folderCandidates({
      kind: 'movie',
      titles: ['Your Name.', '君の名は。', 'Your Name: The Movie'],
      year: 2016,
      limit: 4,
    });
    expect(candidates).toEqual([
      'Your Name (2016)',
      'Your Name The Movie (2016)',
      'Your Name - The Movie (2016)',
      'Your Name- The Movie (2016)',
    ]);
  });
});
