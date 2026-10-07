import { silenceSqliteExperimentalWarning } from '../src/core/warnings';

// Comme en production (main.ts) : pas d'avertissement « SQLite expérimental » dans la sortie.
silenceSqliteExperimentalWarning();
