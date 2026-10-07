// Bundle du serveur : nos sources TypeScript sont regroupées dans dist/main.js,
// les dépendances npm restent externes (résolues depuis node_modules à l'exécution).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts', 'src/cli/probe-source.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
