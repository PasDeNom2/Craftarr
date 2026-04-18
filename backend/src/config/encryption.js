const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (raw.length < KEY_LENGTH) {
    return Buffer.from(raw.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));
  }
  return Buffer.from(raw.slice(0, KEY_LENGTH));
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const encrypted = buf.slice(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
