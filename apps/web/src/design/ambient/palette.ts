/**
 * Palette d'ambiance : trois couleurs vives extraites d'une affiche ou d'une image de fond,
 * qui colorent la lumière derrière le verre (« sa couleur s'inspire du contenu qui l'entoure »).
 */
import { hashSeed } from '../../lib/artwork';

export type Palette = readonly [string, string, string];

export const DEFAULT_PALETTE: Palette = ['hsl(38 85% 42%)', 'hsl(232 60% 46%)', 'hsl(186 60% 34%)'];

const SAMPLE_SIZE = 32;
const cache = new Map<string, Promise<Palette | null>>();

/** Palette déterministe pour un titre sans illustration (mêmes teintes que l'affiche générée). */
export function paletteFromSeed(seed: string): Palette {
  const value = hashSeed(seed);
  const hue = value % 360;
  const second = (hue + 35 + ((value >> 9) % 70)) % 360;
  return [`hsl(${hue} 72% 44%)`, `hsl(${second} 62% 40%)`, `hsl(${(hue + 200) % 360} 50% 32%)`];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function toAmbient(r: number, g: number, b: number): string {
  const [hue, saturation, lightness] = rgbToHsl(r, g, b);
  // Couleurs lumineuses mais sombres : de la lumière d'ambiance, jamais un aplat criard.
  return `hsl(${Math.round(hue)} ${Math.round(clamp(saturation, 0.42, 0.88) * 100)}% ${Math.round(
    clamp(lightness, 0.32, 0.5) * 100,
  )}%)`;
}

/**
 * Trois couleurs dominantes et vives de pixels RGBA (histogramme pondéré par la vivacité,
 * par tranches de 30° de teinte, en privilégiant des teintes distinctes).
 * `null` si l'image est trop terne (niveaux de gris, noir…).
 */
export function paletteFromPixels(data: ArrayLike<number>): Palette | null {
  const buckets = Array.from({ length: 12 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    const [hue, saturation, lightness] = rgbToHsl(r, g, b);
    if (saturation < 0.18 || lightness < 0.08 || lightness > 0.92) continue;
    const weight = saturation * (1 - Math.abs(lightness - 0.5));
    const bucket = buckets[Math.floor(hue / 30) % 12];
    if (!bucket) continue;
    bucket.weight += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
  }
  const ranked = buckets
    .map((bucket, index) => ({ ...bucket, index }))
    .filter((bucket) => bucket.weight > 0.6)
    .sort((a, b) => b.weight - a.weight);
  if (ranked.length === 0) return null;

  const chosen: typeof ranked = [];
  for (const bucket of ranked) {
    const distinct = chosen.every((other) => {
      const gap = Math.abs(other.index - bucket.index);
      return Math.min(gap, 12 - gap) >= 2;
    });
    if (distinct) chosen.push(bucket);
    if (chosen.length === 3) break;
  }
  for (const bucket of ranked) {
    if (chosen.length === 3) break;
    if (!chosen.includes(bucket)) chosen.push(bucket);
  }
  const colors = chosen.map((bucket) =>
    toAmbient(bucket.r / bucket.weight, bucket.g / bucket.weight, bucket.b / bucket.weight),
  );
  const [first] = colors;
  if (!first) return null;
  return [first, colors[1] ?? first, colors[2] ?? colors[1] ?? first];
}

async function extract(url: string): Promise<Palette | null> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return paletteFromPixels(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
}

/** Palette d'une image (même origine), mise en cache ; `null` si l'image est trop terne ou illisible. */
export function paletteFromImage(url: string): Promise<Palette | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = extract(url).catch(() => null);
    cache.set(url, pending);
    if (cache.size > 120) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return pending;
}
