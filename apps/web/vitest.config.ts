import { defineConfig } from 'vitest/config';

// Tests unitaires de la logique de l'interface (fonctions pures, sans navigateur).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
