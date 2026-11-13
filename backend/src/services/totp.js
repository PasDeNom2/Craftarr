// Service TOTP (RFC 6238) et codes de secours sans dépendance externe.
const crypto = require('crypto');
const { decrypt } = require('../config/encryption');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

// Cache mémoire anti-rejeu (complète totp_last_step en DB)
const lastAcceptedSteps = new Map();

/** Encode un Buffer en Base32 (RFC 4648, sans padding). */
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Décode une chaîne Base32 en Buffer. */
function base32Decode(str) {
  const clean = String(str || '').replace(/[\s=-]+/g, '').toUpperCase();
  if (!clean) throw new Error('Secret Base32 vide');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Caractère Base32 invalide');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Génère un secret Base32 aléatoire (160 bits par défaut). */
function generateSecret(numBytes = 20) {
  return base32Encode(crypto.randomBytes(numBytes));
}

/** Construit l'URI otpauth:// pour les applications d'authentification. */
function buildOtpAuthUri({ secret, username, issuer = 'Craftarr' }) {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** Calcule le pas de temps courant (30 s). */
function getTimeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** Calcule un code HOTP à 6 chiffres pour un compteur donné (HMAC-SHA1). */
function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % (10 ** DIGITS);
  return String(code).padStart(DIGITS, '0');
}

/** Génère le code TOTP courant (utile côté tests et debug). */
function generateTotp(secretBase32, nowMs = Date.now()) {
  return hotp(secretBase32, getTimeStep(nowMs));
}

/** Compare deux chaînes de même longueur en temps constant. */
function safeEqualStr(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Vérifie un code TOTP dans la fenêtre ±1 pas (30 s).
 * Retourne { valid: true, step } ou { valid: false, replayed?: boolean }.
 */
function verifyTotp(secretBase32, rawCode, { window = 1, lastAcceptedStep = null, nowMs = Date.now() } = {}) {
  const code = String(rawCode ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { valid: false, replayed: false };

  const currentStep = getTimeStep(nowMs);
  let matchedStep = null;

  // Parcourt toute la fenêtre sans court-circuit pour garder un temps constant
  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = hotp(secretBase32, step);
    if (safeEqualStr(code, expected) && matchedStep === null) {
      matchedStep = step;
    }
  }

  if (matchedStep === null) return { valid: false, replayed: false };
  if (lastAcceptedStep !== null && lastAcceptedStep !== undefined && matchedStep <= lastAcceptedStep) {
    return { valid: false, replayed: true };
  }
  return { valid: true, step: matchedStep };
}

/** Vérifie le TOTP d'un utilisateur et mémorise le pas accepté (anti-rejeu). */
function verifyUserTotp(db, user, rawCode, nowMs = Date.now()) {
  const secret = decrypt(user.totp_secret);
  if (!secret) return { valid: false, replayed: false };

  const dbStep = user.totp_last_step ?? null;
  const memStep = lastAcceptedSteps.get(user.id) ?? null;
  const lastStep = dbStep !== null && memStep !== null
    ? Math.max(dbStep, memStep)
    : (dbStep ?? memStep);

  const res = verifyTotp(secret, rawCode, { lastAcceptedStep: lastStep, nowMs });
  if (!res.valid) return res;

  lastAcceptedSteps.set(user.id, res.step);
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(res.step, user.id);
  return res;
}

/** Génère N codes de secours lisibles (XXXX-XXXX-XXXX-XXXX, 64 bits d'entropie chacun). */
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
    codes.push(hex.match(/.{4}/g).join('-'));
  }
  return codes;
}

/** Normalise et hache (SHA-256) un code de secours. */
function hashRecoveryCode(code) {
  const normalized = String(code ?? '').replace(/[\s-]+/g, '').toUpperCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Vérifie un code de secours et le consomme s'il est valide. */
function verifyAndConsumeRecoveryCode(hashesJson, rawCode) {
  const clean = String(rawCode ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (!clean) return { valid: false };

  let hashes = [];
  try {
    const parsed = JSON.parse(hashesJson || '[]');
    if (Array.isArray(parsed)) hashes = parsed.filter(h => typeof h === 'string');
  } catch {
    hashes = [];
  }
  if (!hashes.length) return { valid: false };

  const candHash = hashRecoveryCode(clean);
  let matchedIndex = -1;
  for (let i = 0; i < hashes.length; i++) {
    if (safeEqualStr(candHash, hashes[i]) && matchedIndex === -1) {
      matchedIndex = i;
    }
  }
  if (matchedIndex === -1) return { valid: false };

  const remaining = hashes.filter((_, idx) => idx !== matchedIndex);
  return { valid: true, remainingHashesJson: JSON.stringify(remaining) };
}

function clearReplayCache(userId) {
  if (userId) lastAcceptedSteps.delete(userId);
  else lastAcceptedSteps.clear();
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  buildOtpAuthUri,
  getTimeStep,
  hotp,
  generateTotp,
  verifyTotp,
  verifyUserTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyAndConsumeRecoveryCode,
  clearReplayCache,
};
