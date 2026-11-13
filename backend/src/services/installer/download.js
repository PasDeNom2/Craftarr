const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_STALL_MS = 60000;

/**
 * Télécharge url → dest de façon sûre :
 *  - écrit dans dest.part puis renomme (jamais de fichier tronqué à la place du vrai),
 *  - abandonne si aucun octet reçu pendant 60 s (stream bloqué),
 *  - vérifie la taille (content-length) et le hash si fourni ({ sha1 } ou { sha512 }),
 *  - réessaie 3 fois avec backoff.
 */
async function downloadFile(url, dest, onProgress, expected = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      await downloadOnce(url, dest, onProgress, expected);
      return;
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 404 || err.response?.status === 403) break; // inutile de réessayer
      if (attempt < DOWNLOAD_RETRIES) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Téléchargement échoué (${path.basename(dest)}) : ${lastErr?.message}`);
}

/** Essaie chaque URL dans l'ordre (API puis CDN de secours) ; échoue avec la dernière erreur. */
async function downloadAny(urls, dest, onProgress, expected = {}) {
  let lastErr = new Error('aucune URL de téléchargement');
  for (const url of urls) {
    try {
      await downloadFile(url, dest, onProgress, expected);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function downloadOnce(url, dest, onProgress, expected) {
  const tmp = `${dest}.part`;
  const res = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const algo = expected.sha512 ? 'sha512' : expected.sha1 ? 'sha1' : null;
  const hash = algo ? crypto.createHash(algo) : null;
  let downloaded = 0;

  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmp);
      let stall = setTimeout(() => res.data.destroy(new Error('téléchargement bloqué (aucune donnée depuis 60 s)')), DOWNLOAD_STALL_MS);
      res.data.on('data', chunk => {
        clearTimeout(stall);
        stall = setTimeout(() => res.data.destroy(new Error('téléchargement bloqué (aucune donnée depuis 60 s)')), DOWNLOAD_STALL_MS);
        downloaded += chunk.length;
        if (hash) hash.update(chunk);
        if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
      });
      res.data.on('end', () => clearTimeout(stall));
      res.data.on('error', err => { clearTimeout(stall); writer.destroy(); reject(err); });
      writer.on('error', err => { clearTimeout(stall); reject(err); });
      writer.on('finish', resolve);
      res.data.pipe(writer);
    });

    if (total > 0 && downloaded !== total) throw new Error(`taille incorrecte (${downloaded}/${total} octets)`);
    if (hash) {
      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== String(expected[algo]).toLowerCase()) throw new Error(`hash ${algo} invalide`);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Joint un chemin d'archive à baseDir en refusant toute sortie du dossier (zip-slip). */
function safeJoin(baseDir, relative) {
  const dest = path.resolve(baseDir, relative);
  const base = path.resolve(baseDir);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`Chemin d'archive refusé (sort du dossier serveur) : ${relative}`);
  }
  return dest;
}

module.exports = { DOWNLOAD_RETRIES, DOWNLOAD_STALL_MS, downloadFile, downloadAny, downloadOnce, safeJoin };
