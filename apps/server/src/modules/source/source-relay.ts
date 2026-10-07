import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../../config/env';

/**
 * Relais local des fichiers de la source pour ffmpeg et ffprobe.
 *
 * Plutôt que de contacter la source eux-mêmes (avec leur propre client HTTP, que les
 * protections anti-robot refusent), ils lisent une URL locale de Lumière qui relaie les
 * requêtes (plages d'octets comprises) par le même transport que le reste de l'application.
 * Un jeton aléatoire, propre à chaque démarrage, réserve ce point d'accès au serveur.
 */
export class SourceRelay {
  private readonly token = randomBytes(24).toString('hex');
  private origin: string;

  constructor(config: Pick<AppConfig, 'host' | 'port'>) {
    this.origin = `http://${loopbackHost(config.host)}:${config.port}`;
  }

  /** Adresse réelle d'écoute (connue après le démarrage du serveur HTTP). */
  setListeningAddress(address: AddressInfo | string | null): void {
    if (!address || typeof address === 'string') return;
    this.origin = `http://${loopbackHost(address.address)}:${address.port}`;
  }

  urlFor(remotePath: string): string {
    const query = new URLSearchParams({ path: remotePath, token: this.token });
    return `${this.origin}/api/internal/source?${query.toString()}`;
  }

  isValidToken(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

/** Adresse de bouclage à utiliser pour joindre un serveur qui écoute sur `host`. */
export function loopbackHost(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}
