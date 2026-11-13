// @ts-check
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

/**
 * @returns {Buffer}
 */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (raw.length < KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY absente ou trop courte (minimum ${KEY_LENGTH} caractères requis)`);
  }
  return Buffer.from(raw.slice(0, KEY_LENGTH));
}

/**
 * Chiffre une chaîne UTF-8 avec AES-256-GCM (encodée en base64).
 * @param {string | null | undefined} plaintext
 * @returns {string | null}
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Déchiffre une chaîne produite par encrypt(), ou retourne null en cas d'échec.
 * @param {string | null | undefined} ciphertext
 * @returns {string | null}
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const key = getKey();
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const encrypted = buf.slice(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
