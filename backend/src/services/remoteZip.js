const axios = require('axios');
const zlib = require('zlib');

/**
 * Lit UN fichier (ex. manifest.json, modrinth.index.json) dans un zip distant sans télécharger
 * le zip entier : requêtes HTTP Range sur la fin du fichier (EOCD), le répertoire central,
 * puis les seules données de l'entrée voulue.
 *
 * Les CDN (forgecdn) redirigent : les requêtes Range doivent viser l'URL FINALE, sinon 404.
 * C'était la cause de la liste de mods vide : le code retombait sur le téléchargement complet
 * du pack (199 Mo pour ATM10) en mémoire, et l'interface abandonnait avant la fin.
 */

// Au-delà, on refuse le téléchargement complet de secours (mémoire du backend, délai de l'UI)
const MAX_FULL_DOWNLOAD = 40 * 1024 * 1024;
const TIMEOUT = 15000;

async function getRange(url, start, end) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: TIMEOUT,
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (res.status !== 206) throw new Error(`Range non supporté (HTTP ${res.status})`);
  return Buffer.from(res.data);
}

/** Taille, support des Range et URL finale (après redirections). */
async function probe(url) {
  const res = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
  return {
    finalUrl: res.request?.res?.responseUrl || url,
    size: parseInt(res.headers['content-length'] || '0', 10),
    ranges: res.headers['accept-ranges'] === 'bytes',
  };
}

async function readEntryByRange(url, size, entryName) {
  // 1. EOCD (22 octets + commentaire éventuel, 64 Ko max)
  const tailSize = Math.min(65557, size);
  const tail = await getRange(url, size - tailSize, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('fin de zip introuvable');
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw new Error('zip64 non géré');

  // 2. Répertoire central → position de l'entrée
  const cd = await getRange(url, cdOffset, cdOffset + cdSize - 1);
  let pos = 0;
  let entry = null;
  while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
    const method = cd.readUInt16LE(pos + 10);
    const compressedSize = cd.readUInt32LE(pos + 20);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const localOffset = cd.readUInt32LE(pos + 42);
    const name = cd.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (name === entryName) { entry = { method, compressedSize, localOffset }; break; }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) return null;

  // 3. En-tête local (longueurs propres au fichier) puis données compressées
  const lh = await getRange(url, entry.localOffset, entry.localOffset + 29);
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const data = entry.compressedSize
    ? await getRange(url, dataStart, dataStart + entry.compressedSize - 1)
    : Buffer.alloc(0);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  if (entry.method === 0) return data;
  throw new Error(`compression ${entry.method} non gérée`);
}

async function readEntryFull(url, entryName) {
  const AdmZip = require('adm-zip');
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_FULL_DOWNLOAD });
  const e = new AdmZip(Buffer.from(res.data)).getEntry(entryName);
  return e ? e.getData() : null;
}

/**
 * Contenu d'une entrée du zip distant (Buffer), ou null si absente / illisible.
 * knownSize : taille fournie par l'API, utilisée si le HEAD ne la donne pas.
 */
async function readZipEntry(url, entryName, knownSize = 0) {
  let info;
  try {
    info = await probe(url);
  } catch {
    info = { finalUrl: url, size: knownSize, ranges: !!knownSize };
  }
  const size = info.size || knownSize;

  if (info.ranges && size) {
    try {
      return await readEntryByRange(info.finalUrl, size, entryName);
    } catch (err) {
      console.warn(`[remoteZip] Lecture partielle impossible (${err.message}) : ${info.finalUrl.slice(0, 80)}`);
    }
  }
  if (size && size > MAX_FULL_DOWNLOAD) return null; // pas de téléchargement complet d'un gros pack
  try {
    return await readEntryFull(info.finalUrl, entryName);
  } catch {
    return null;
  }
}

/** Variante JSON de readZipEntry. */
async function readZipJson(url, entryName, knownSize = 0) {
  const buf = await readZipEntry(url, entryName, knownSize);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

module.exports = { readZipEntry, readZipJson, _internals: { readEntryByRange } };
