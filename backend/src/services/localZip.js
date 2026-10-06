const fs = require('fs');
const zlib = require('zlib');

/**
 * Lecture ciblée d'entrées dans un zip (fichier sur disque ou Buffer) : on lit le répertoire
 * central puis seulement les entrées demandées. adm-zip chargeait chaque jar ENTIER en mémoire :
 * 43 s pour analyser les 351 mods d'un gros pack, contre quelques secondes ici.
 */

function sourceOf(input) {
  if (Buffer.isBuffer(input)) {
    return { size: input.length, read: (pos, len) => input.subarray(pos, pos + len), close() {} };
  }
  const fd = fs.openSync(input, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(pos, len) {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      return n === len ? buf : buf.subarray(0, n);
    },
    close() { fs.closeSync(fd); },
  };
}

/**
 * Ouvre un zip. Retourne { names, has(name), read(name) → Buffer|null, close() }.
 * Lève une erreur si ce n'est pas un zip lisible (l'appelant décide quoi faire).
 */
function openZip(input) {
  const src = sourceOf(input);
  try {
    const tailLen = Math.min(65557, src.size);
    if (tailLen < 22) throw new Error('fichier trop court');
    const tail = src.read(src.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('pas un zip');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xFFFFFFFF) throw new Error('zip64 non géré');

    const cd = src.read(cdOffset, cdSize);
    const entries = new Map();
    let pos = 0;
    while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      entries.set(name, {
        method: cd.readUInt16LE(pos + 10),
        compressedSize: cd.readUInt32LE(pos + 20),
        size: cd.readUInt32LE(pos + 24),
        offset: cd.readUInt32LE(pos + 42),
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    return {
      names: [...entries.keys()],
      has: name => entries.has(name),
      read(name) {
        const e = entries.get(name);
        if (!e || name.endsWith('/')) return null;
        const lh = src.read(e.offset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return null;
        const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = src.read(start, e.compressedSize);
        if (e.method === 0) return data;
        if (e.method === 8) return zlib.inflateRawSync(data);
        return null;
      },
      close: () => src.close(),
    };
  } catch (err) {
    src.close();
    throw err;
  }
}

module.exports = { openZip };
