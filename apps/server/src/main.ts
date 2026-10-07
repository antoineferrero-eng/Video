import { buildApp } from './app';
import { loadConfig, loadEnvFile } from './config/env';
import { createContainer, startServices, stopServices } from './container';
import { errorMessage } from './core/errors';
import { createLogger } from './core/logger';
import { silenceSqliteExperimentalWarning } from './core/warnings';

async function main(): Promise<void> {
  silenceSqliteExperimentalWarning();
  const envFile = loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: config.prettyLogs });
  if (envFile) logger.info({ file: envFile }, 'Configuration chargée depuis le fichier .env');
  const container = createContainer(config, logger);
  const app = await buildApp(container);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Arrêt en cours…');
    try {
      await app.close();
      await stopServices(container);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      logger.fatal(
        `Le port ${config.port} est déjà utilisé : définissez la variable PORT pour en choisir un autre.`,
      );
    } else {
      logger.fatal({ err: errorMessage(error) }, 'Démarrage impossible');
    }
    await stopServices(container).catch(() => undefined);
    process.exit(1);
  }

  container.relay.setListeningAddress(app.server.address());
  await startServices(container);
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info(`Lumière est prêt : http://${host}:${config.port}`);
}

main().catch((error: unknown) => {
  console.error('Erreur fatale :', error);
  process.exit(1);
});
