import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  entryDataOffset,
  extractEntry,
  fileReader,
  readZipEntries,
  type ReadRange,
} from '../src/modules/archives/zip';
import { buildZip } from './helpers/zip-writer';

const episodes = [1, 2].map((episode) => ({
  name: `Saison 1/Serie.S01E0${episode}.1080p.mkv`,
  data: crypto.randomBytes(40_000 + episode),
}));
const subtitles = {
  name: 'Saison 1/Serie.S01E01.fr.srt',
  data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nBonjour\n'),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumiere-zip-'));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function memoryReader(bytes: Buffer): ReadRange {
  return async (start, end) => bytes.subarray(start, end + 1);
}

describe('archives zip', () => {
  for (const zip64 of [false, true]) {
    it(`liste le contenu et situe les données${zip64 ? ' (ZIP64)' : ''}`, async () => {
      const archive = buildZip(
        [...episodes, subtitles, { name: 'Saison 1/', data: Buffer.alloc(0) }],
        {
          zip64,
        },
      );
      const read = memoryReader(archive);
      const entries = await readZipEntries(read, archive.length);
      expect(entries.map((entry) => [entry.name, entry.size, entry.method])).toEqual([
        [episodes[0]!.name, episodes[0]!.data.length, 0],
        [episodes[1]!.name, episodes[1]!.data.length, 0],
        [subtitles.name, subtitles.data.length, 0],
      ]);
      // Élément stocké : ses octets sont une plage continue de l'archive.
      const second = entries[1]!;
      const start = await entryDataOffset(read, second);
      expect(archive.subarray(start, start + second.size).equals(episodes[1]!.data)).toBe(true);
    });
  }

  it('refuse un fichier qui n’est pas une archive', async () => {
    const bytes = crypto.randomBytes(5000);
    await expect(readZipEntries(memoryReader(bytes), bytes.length)).rejects.toThrow(/zip/);
  });

  it('extrait les éléments stockés et compressés d’une archive locale', async () => {
    const file = path.join(dir, 'saison.zip');
    fs.writeFileSync(
      file,
      buildZip([
        { ...episodes[0]!, compress: true },
        { ...episodes[1]!, compress: false },
      ]),
    );
    const handle = await fsp.open(file, 'r');
    const read = fileReader(handle);
    const entries = await readZipEntries(read, (await handle.stat()).size);
    const offsets = await Promise.all(entries.map((entry) => entryDataOffset(read, entry)));
    await handle.close();
    for (const [index, entry] of entries.entries()) {
      const target = path.join(dir, `episode-${index}.mkv`);
      await extractEntry(file, entry, offsets[index]!, target);
      expect(fs.readFileSync(target).equals(episodes[index]!.data)).toBe(true);
    }
  });
});
