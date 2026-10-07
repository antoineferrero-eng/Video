// Lance le serveur (API) et l'interface (Vite) en parallèle pour le développement.
// Remplace `concurrently` sans dépendance supplémentaire, compatible Windows/macOS/Linux.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tasks = [
  { name: 'server', color: '\x1b[33m', workspace: '@lumiere/server' },
  { name: 'web', color: '\x1b[36m', workspace: '@lumiere/web' },
];

const children = tasks.map(({ name, color, workspace }) => {
  const child = spawn(npm, ['run', 'dev', '-w', workspace], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const prefix = `${color}[${name}]\x1b[0m `;
  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}terminé (code ${code ?? 'null'})\n`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
