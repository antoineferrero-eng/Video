/** Empreinte stable d'une chaîne (FNV-1a), pour dériver des couleurs d'un titre. */
export function hashSeed(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Dégradé déterministe pour les affiches générées (titres sans illustration). */
export function gradientFor(seed: string): string {
  const value = hashSeed(seed);
  const hue = value % 360;
  const second = (hue + 35 + ((value >> 9) % 70)) % 360;
  return `radial-gradient(120% 90% at 20% 0%, hsl(${hue} 70% 42% / 0.85), transparent 60%),
    linear-gradient(160deg, hsl(${hue} 45% 22%), hsl(${second} 55% 9%))`;
}
