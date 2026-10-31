import { describe, expect, it } from 'vitest';
import {
  findOneFichierUrl,
  oneFichierPath,
  parseOneFichierPath,
  parseOneFichierUrl,
} from '../src/modules/source/onefichier/onefichier-link';
import { parseAccount } from '../src/modules/source/onefichier/onefichier.client';

describe('liens 1fichier', () => {
  it('ramène un lien à la forme acceptée par l’API', () => {
    expect(parseOneFichierUrl('https://1fichier.com/?abcde12345')).toEqual({
      url: 'https://1fichier.com/?abcde12345',
      fileId: 'abcde12345',
    });
    expect(parseOneFichierUrl('http://www.1fichier.com/?ABCDE12345&af=42')?.url).toBe(
      'https://1fichier.com/?abcde12345',
    );
    expect(parseOneFichierUrl('https://megadl.fr/?k9x8w7v6u5')?.url).toBe(
      'https://megadl.fr/?k9x8w7v6u5',
    );
    // Ancienne forme, identifiant en sous-domaine.
    expect(parseOneFichierUrl('https://abcde12345.1fichier.com/')?.url).toBe(
      'https://1fichier.com/?abcde12345',
    );
  });

  it('refuse ce qui n’est pas un lien de fichier 1fichier', () => {
    expect(parseOneFichierUrl('https://1fichier.com/')).toBeNull();
    expect(parseOneFichierUrl('https://1fichier.com/?ab')).toBeNull();
    expect(parseOneFichierUrl('https://example.com/?abcde12345')).toBeNull();
    expect(parseOneFichierUrl('https://1fichier.com.example.com/?abcde12345')).toBeNull();
    expect(parseOneFichierUrl('javascript:alert(1)')).toBeNull();
  });

  it('trouve le lien dans un texte copié', () => {
    expect(
      findOneFichierUrl(
        'Voici : https://loadix.fun/media/1 puis https://1fichier.com/?qwert12345 !',
      )?.fileId,
    ).toBe('qwert12345');
    expect(findOneFichierUrl('aucun lien ici')).toBeNull();
  });

  it('donne un chemin stable au fichier', () => {
    const path = oneFichierPath('abcde12345', 'Film.2024.mkv');
    expect(path).toBe('/@1fichier/abcde12345/Film.2024.mkv');
    expect(parseOneFichierPath(path)).toEqual({ fileId: 'abcde12345', fileName: 'Film.2024.mkv' });
    expect(parseOneFichierPath('/@stremio/movie/tt1/Film.mkv')).toBeNull();
  });
});

describe('compte 1fichier', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');

  it('reconnaît l’offre, en nombre comme en texte', () => {
    expect(parseAccount({ offer: 1 }, now).offer).toBe('Premium');
    expect(parseAccount({ offer: '3' }, now).offer).toBe('Premium GOLD');
    expect(parseAccount({ offer: 9 }, now).offer).toBe('offre n° 9');
  });

  it('se fie à la fin d’abonnement quand l’offre manque', () => {
    expect(parseAccount({ subscription_end: '2027-01-31 12:00:00' }, now).offer).toBe('abonnement');
    expect(parseAccount({ offer: 0, subscription_end: '2025-01-31 12:00:00' }, now)).toMatchObject({
      offer: null,
      rawOffer: 0,
    });
  });
});
