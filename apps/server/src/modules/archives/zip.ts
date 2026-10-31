import fs from 'node:fs';
import type fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

/**
 * Lecture des archives zip par plages d'octets : la même lecture sert pour une archive
 * distante (requêtes Range sur son lien) et pour un fichier local. Seul le répertoire
 * central, en fin d'archive, est lu pour lister le contenu ; ZIP64 (archives et fichiers de
 * plus de 4 Go) est pris en charge.
 *
 * Une vidéo « stockée » (méthode 0, sans compression : le cas habituel, la vidéo ne se
 * compressant pas) occupe une plage continue de l'archive : on peut la lire et la
 * télécharger directement à l'intérieur. Une vidéo compressée (méthode 8, deflate) doit être
 * décompressée en entier, après le téléchargement de l'archive.
 */

/** Lit les octets [start, end] (bornes comprises). */
export type ReadRange = (start: number, end: number) => Promise<Buffer>;

export interface ZipEntry {
  /** Chemin complet dans l'archive. */
  name: string;
  /** 0 : stocké, 8 : deflate. */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export const STORED = 0;
export const DEFLATE = 8;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const UNSET32 = 0xffffffff;

export class ZipError extends Error {}

/** Contenu d'une archive zip (dossiers exclus). */
export async function readZipEntries(read: ReadRange, totalSize: number): Promise<ZipEntry[]> {
  if (totalSize < EOCD_SIZE) throw new ZipError('Archive zip vide ou tronquée.');
  const tailStart = Math.max(0, totalSize - (EOCD_SIZE + MAX_COMMENT + ZIP64_LOCATOR_SIZE));
  const tail = await read(tailStart, totalSize - 1);
  let eocd = -1;
  for (let index = tail.length - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Ce fichier n’est pas une archive zip lisible.');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipError('Archive zip en plusieurs morceaux : non prise en charge.');
  }
  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  const locator = eocd - ZIP64_LOCATOR_SIZE;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
    const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
    const record = await read(recordOffset, recordOffset + 55);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipError('Archive ZIP64 illisible.');
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }
  if (directoryOffset + directorySize > totalSize) {
    throw new ZipError('Archive zip incomplète (répertoire hors du fichier).');
  }
  const directory =
    directorySize > 0
      ? await read(directoryOffset, directoryOffset + directorySize - 1)
      : Buffer.alloc(0);

  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_SIZE > directory.length || directory.readUInt32LE(offset) !== CENTRAL) {
      throw new ZipError('Répertoire de l’archive zip illisible.');
    }
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    let compressedSize = directory.readUInt32LE(offset + 20);
    let size = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    let localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_SIZE;
    const name = decodeName(directory.subarray(nameStart, nameStart + nameLength), flags);

    // Champ ZIP64 : valeurs présentes dans l'ordre, pour celles marquées 0xFFFFFFFF.
    let extra = nameStart + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        const next = (): number => {
          const value = Number(directory.readBigUInt64LE(field));
          field += 8;
          return value;
        };
        if (size === UNSET32) size = next();
        if (compressedSize === UNSET32) compressedSize = next();
        if (localHeaderOffset === UNSET32) localHeaderOffset = next();
      }
      extra += 4 + length;
    }
    offset = extraEnd + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      method,
      compressedSize,
      size,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });
  }
  return entries;
}

/** Début des données d'un élément (après son en-tête local, de longueur variable). */
export async function entryDataOffset(read: ReadRange, entry: ZipEntry): Promise<number> {
  const header = await read(entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_SIZE - 1);
  if (header.readUInt32LE(0) !== LOCAL) throw new ZipError('En-tête d’élément zip illisible.');
  return entry.localHeaderOffset + LOCAL_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** Nom d'un élément : UTF-8 s'il est annoncé (ou valide), sinon page de code DOS approchée. */
function decodeName(bytes: Buffer, flags: number): string {
  if (flags & 0x800) return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** Lecture par plages d'un fichier local. */
export function fileReader(handle: fsp.FileHandle): ReadRange {
  return async (start, end) => {
    const buffer = Buffer.alloc(end - start + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  };
}

/** Extrait un élément d'une archive locale vers `target` (stocké ou deflate). */
export async function extractEntry(
  archive: string,
  entry: ZipEntry,
  dataOffset: number,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.encrypted) throw new ZipError(`${entry.name} : élément chiffré, non pris en charge.`);
  if (entry.method !== STORED && entry.method !== DEFLATE) {
    throw new ZipError(
      `${entry.name} : méthode de compression ${entry.method} non prise en charge.`,
    );
  }
  const source = fs.createReadStream(archive, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  const output = fs.createWriteStream(target);
  if (entry.method === STORED) await pipeline(source, output, { signal });
  else await pipeline(source, createInflateRaw(), output, { signal });
}
