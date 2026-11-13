// @ts-check
// Helpers de validation sans dépendance pour les routes API.

/** @typedef {import('../types').HttpError} HttpError */

/**
 * Construit une HttpError 400.
 * @param {string} message
 * @returns {HttpError}
 */
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Valide et normalise un entier (Number ou chaîne de chiffres) dans [min, max].
 * @param {unknown} value
 * @param {{ min?: number, max?: number, field?: string }} [opts]
 * @returns {number}
 */
function int(value, { min, max, field = 'valeur' } = {}) {
  let n;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw badRequest(`«${field}» doit être un entier entre ${min} et ${max}`);
    }
    n = value === 0 ? 0 : value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw badRequest(`«${field}» doit être un entier entre ${min} et ${max}`);
    }
    n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      throw badRequest(`«${field}» doit être un entier entre ${min} et ${max}`);
    }
    if (n === 0) n = 0;
  } else {
    throw badRequest(`«${field}» doit être un entier entre ${min} et ${max}`);
  }

  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw badRequest(`«${field}» doit être un entier entre ${min} et ${max}`);
  }
  return n;
}

/**
 * Valide et normalise un booléen (true/false, 1/0, 'true'/'false', '1'/'0').
 * @param {unknown} value
 * @param {string} [field]
 * @returns {boolean}
 */
function bool(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  throw badRequest(field ? `«${field}» doit être un booléen` : 'Valeur booléenne invalide');
}

/**
 * Valide et nettoie une chaîne de caractères.
 * @param {unknown} value
 * @param {{ max?: number, field?: string, allowEmpty?: boolean, noNewlines?: boolean }} [opts]
 * @returns {string}
 */
function str(value, { max, field = 'valeur', allowEmpty = false, noNewlines = false } = {}) {
  if (typeof value !== 'string') {
    throw badRequest(`«${field}» doit être une chaîne de caractères`);
  }
  const s = value.trim();
  if (!allowEmpty && s.length === 0) {
    throw badRequest(`«${field}» ne peut pas être vide`);
  }
  if (noNewlines && /[\r\n]/.test(s)) {
    throw badRequest(`«${field}» ne doit pas contenir de retour à la ligne`);
  }
  if (max !== undefined && s.length > max) {
    throw badRequest(`«${field}» ne doit pas dépasser ${max} caractères`);
  }
  return s;
}

/**
 * Vérifie que la valeur appartient à une liste autorisée.
 * @template T
 * @param {unknown} value
 * @param {readonly T[]} list
 * @param {string} [field='valeur']
 * @returns {T}
 */
function oneOf(value, list, field = 'valeur') {
  if (!list.includes(/** @type {T} */ (value))) {
    throw badRequest(`«${field}» doit être parmi : ${list.join(', ')}`);
  }
  return /** @type {T} */ (value);
}

module.exports = { int, bool, str, oneOf };
