// @ts-check
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

// Plafond par défaut pour l'extraction d'archives (20 Gio)
/** @type {number} */
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

/**
 * Liste les noms d'entrées d'une archive zip en lecture séquentielle (sans tout charger en RAM).
 * Remplace les séparateurs Windows '\' par '/'.
 * @param {string} zipPath
 * @returns {Promise<string[]>}
 */
function listEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) return reject(openErr);
      /** @type {string[]} */
      const entries = [];
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch {}
        reject(err);
      };

      zipfile.on('error', fail);
      zipfile.on('entry', (entry) => {
        entries.push(entry.fileName.replace(/\\/g, '/'));
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Valide un nom d'entrée zip et calcule le chemin cible sûr à l'intérieur de resolvedDest.
 * Refuse chemins absolus, lecteurs Windows, octets nuls et traversées '..'.
 * @param {string} resolvedDest
 * @param {string} rawName
 * @returns {{ parts: string[], targetPath: string, isDir: boolean }}
 */
function resolveSafeTarget(resolvedDest, rawName) {
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.includes('\0')) {
    throw new Error(`Nom d'entrée invalide (caractère nul) : ${rawName}`);
  }
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Chemin absolu interdit dans l'archive : ${rawName}`);
  }
  const rawParts = normalized.split('/');
  if (rawParts.some(part => part === '..')) {
    throw new Error(`Traversée de chemin interdite dans l'archive : ${rawName}`);
  }
  const parts = rawParts.filter(part => part !== '' && part !== '.');
  const targetPath = path.resolve(resolvedDest, ...parts);
  if (targetPath !== resolvedDest && !targetPath.startsWith(resolvedDest + path.sep)) {
    throw new Error(`Chemin hors destination interdit : ${rawName}`);
  }
  return { parts, targetPath, isDir: normalized.endsWith('/') };
}

/**
 * Crée récursivement les sous-dossiers sous resolvedDest avec le mode 0o755,
 * sans jamais suivre un lien symbolique existant.
 * @param {string} resolvedDest
 * @param {string[]} dirParts
 * @returns {void}
 */
function ensureDirSafe(resolvedDest, dirParts) {
  let current = resolvedDest;
  for (const part of dirParts) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Lien symbolique détecté dans la destination : ${current}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Conflit fichier/dossier dans la destination : ${current}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fs.mkdirSync(current, { mode: 0o755 });
    }
  }
}

/**
 * Extrait une archive zip en flux vers destDir.
 * - Refuse chemins absolus, traversées '..', liens symboliques (mode Unix 0o120000).
 * - Refuse tout dépassement de maxTotalBytes en octets réellement écrits pendant le flux.
 * - Ne suit jamais un lien symbolique dans la destination.
 * - Crée les dossiers en 0o755 et les fichiers en 0o644 (sans SUID/SGID).
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ maxTotalBytes?: number }} [opts]
 * @returns {Promise<void>}
 */
function extractAll(zipPath, destDir, { maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const resolvedDest = path.resolve(destDir);
    try {
      const st = fs.lstatSync(resolvedDest);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return reject(new Error(`Destination invalide : ${resolvedDest}`));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') return reject(err);
      fs.mkdirSync(resolvedDest, { recursive: true, mode: 0o755 });
    }

    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) return reject(openErr);

      let totalBytes = 0;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch {}
        reject(err);
      };

      async function handleEntry(entry) {
        // Rejet des liens symboliques (bits S_IFLNK = 0o120000 dans les 16 bits hauts)
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixType === 0o120000) {
          throw new Error(`Lien symbolique interdit dans l'archive : ${entry.fileName}`);
        }

        const { parts, targetPath, isDir } = resolveSafeTarget(resolvedDest, entry.fileName);
        if (parts.length === 0) return;

        if (isDir) {
          ensureDirSafe(resolvedDest, parts);
          return;
        }

        ensureDirSafe(resolvedDest, parts.slice(0, -1));
        try {
          const st = fs.lstatSync(targetPath);
          if (st.isSymbolicLink()) {
            throw new Error(`Lien symbolique détecté dans la destination : ${targetPath}`);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }

        const readStream = await new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, stream) => (err ? rej(err) : res(stream)));
        });

        const flags = fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_TRUNC
          | (fs.constants.O_NOFOLLOW || 0);
        const writeStream = fs.createWriteStream(targetPath, { flags: /** @type {any} */ (flags), mode: 0o644 });

        // Compte les octets réellement décompressés pendant le flux (et non la taille déclarée)
        const byteLimiter = new Transform({
          transform(chunk, _enc, cb) {
            totalBytes += chunk.length;
            if (totalBytes > maxTotalBytes) {
              return cb(new Error(`Taille maximale d'extraction dépassée (${maxTotalBytes} octets)`));
            }
            cb(null, chunk);
          },
        });

        await pipeline(readStream, byteLimiter, writeStream);
      }

      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipfile.on('entry', (entry) => {
        if (settled) return;
        handleEntry(entry).then(
          () => { if (!settled) zipfile.readEntry(); },
          fail
        );
      });

      zipfile.readEntry();
    });
  });
}

module.exports = { listEntries, extractAll, DEFAULT_MAX_TOTAL_BYTES };
