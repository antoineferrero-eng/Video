import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Archives zip pour les tests : éléments stockés ou compressés (deflate), et ZIP64 forcé
 * (tailles et positions dans le champ étendu) pour éprouver sa lecture sans fichier de 4 Go.
 */
export interface ZipInput {
  name: string;
  data: Buffer;
  compress?: boolean;
}

const UNSET32 = 0xffffffff;

export function buildZip(inputs: ZipInput[], options: { zip64?: boolean } = {}): Buffer {
  const zip64 = options.zip64 ?? false;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const name = Buffer.from(input.name, 'utf8');
    const data = input.compress ? deflateRawSync(input.data) : input.data;
    const crc = crc32(input.data);
    const method = input.compress ? 8 : 0;
    const localExtra = zip64 ? zip64Extra([input.data.length, data.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? UNSET32 : data.length, 18);
    local.writeUInt32LE(zip64 ? UNSET32 : input.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, data);

    const centralExtra = zip64
      ? zip64Extra([input.data.length, data.length, offset])
      : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(zip64 ? 45 : 20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(zip64 ? UNSET32 : data.length, 20);
    header.writeUInt32LE(zip64 ? UNSET32 : input.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    header.writeUInt32LE(zip64 ? UNSET32 : offset, 42);
    central.push(header, name, centralExtra);
    offset += local.length + name.length + localExtra.length + data.length;
  }
  const directory = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(inputs.length), 24);
    record.writeBigUInt64LE(BigInt(inputs.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : inputs.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : inputs.length, 10);
  end.writeUInt32LE(zip64 ? UNSET32 : directory.length, 12);
  end.writeUInt32LE(zip64 ? UNSET32 : offset, 16);
  return Buffer.concat([...parts, directory, ...tail, end]);
}

function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}
