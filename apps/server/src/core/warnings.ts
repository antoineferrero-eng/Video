/**
 * `node:sqlite` est fonctionnel mais encore signalé « expérimental » par Node.js :
 * on masque cet avertissement précis (les autres restent affichés).
 */
export function silenceSqliteExperimentalWarning(): void {
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(message)) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}
