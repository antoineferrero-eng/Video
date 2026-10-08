const CHUNK = 64 * 1024;

/**
 * Empreinte OpenSubtitles d'un fichier vidéo (« moviehash ») : taille du fichier plus la somme,
 * en mots de 64 bits petit-boutistes, de ses 64 premiers et 64 derniers Kio, modulo 2⁶⁴.
 * Elle désigne une version précise du fichier : les sous-titres qui la portent sont calés
 * dessus. Null pour un fichier de moins de 64 Kio ou de taille inconnue.
 *
 * `read` lit `length` octets à partir de `start` (fichier local ou plage HTTP distante).
 */
export async function openSubtitlesHash(
  size: number | null,
  read: (start: number, length: number) => Promise<Buffer>,
): Promise<string | null> {
  if (size === null || !Number.isSafeInteger(size) || size < CHUNK) return null;
  // Lectures successives : certains hébergeurs refusent les connexions simultanées.
  const head = await read(0, CHUNK);
  const tail = await read(size - CHUNK, CHUNK);
  if (head.length < CHUNK || tail.length < CHUNK) return null;
  let hash = BigInt(size);
  for (const chunk of [head, tail]) {
    for (let offset = 0; offset < CHUNK; offset += 8) hash += chunk.readBigUInt64LE(offset);
  }
  return BigInt.asUintN(64, hash).toString(16).padStart(16, '0');
}
