import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export function createLogger(options: { level: string; pretty: boolean }): Logger {
  return pino({
    level: options.level,
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId' },
          },
        }
      : {}),
  });
}
