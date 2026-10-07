import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import pretty from 'pino-pretty';

export type Logger = PinoLogger;

/**
 * Journal applicatif. Les lignes passent par `process.stdout` : dans une console Windows,
 * Node.js convertit alors le texte pour l'affichage (sinon les accents deviennent « ├® »,
 * car l'écriture directe d'octets UTF-8 est interprétée dans la page de code de la console).
 */
export function createLogger(options: { level: string; pretty: boolean }): Logger {
  const destination: DestinationStream = options.pretty
    ? pretty({
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,reqId',
        destination: process.stdout,
      })
    : process.stdout;
  return pino({ level: options.level }, destination);
}
