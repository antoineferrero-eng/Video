import fs from 'node:fs/promises';
import path from 'node:path';
import { InFlight } from '../../core/async';
import { BadRequestError, NotFoundError, UpstreamError, errorMessage } from '../../core/errors';
import { ensureDir, pathExists } from '../../core/fs';

export const IMAGE_SIZES = new Set([
  'w92',
  'w154',
  'w185',
  'w300',
  'w342',
  'w500',
  'w780',
  'w1280',
  'original',
]);
const FILE_PATTERN = /^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|svg)$/;

/**
 * Cache disque des illustrations TMDB : chaque image n'est téléchargée qu'une fois,
 * puis servie localement (la bibliothèque reste illustrée hors ligne).
 */
export class ImageCache {
  private readonly inflight = new InFlight<string, string>();

  constructor(
    private readonly dir: string,
    private readonly imageBaseUrl: string,
  ) {}

  async get(size: string, file: string): Promise<string> {
    if (!IMAGE_SIZES.has(size) || !FILE_PATTERN.test(file)) {
      throw new BadRequestError('Image invalide.');
    }
    const local = path.join(this.dir, size, file);
    if (await pathExists(local)) return local;

    return this.inflight.run(`${size}/${file}`, async () => {
      let response: Response;
      try {
        response = await fetch(`${this.imageBaseUrl}/${size}/${file}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new UpstreamError(`Image TMDB inaccessible : ${errorMessage(error)}`);
      }
      if (response.status === 404) throw new NotFoundError('Image introuvable.');
      if (!response.ok)
        throw new UpstreamError(`TMDB a répondu ${response.status}`, response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      await ensureDir(path.dirname(local));
      const temp = `${local}.${process.pid}.tmp`;
      await fs.writeFile(temp, buffer);
      await fs.rename(temp, local);
      return local;
    });
  }
}

export function contentTypeForImage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
}
