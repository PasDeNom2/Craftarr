/**
 * Les dates SQLite (datetime('now')) sont en UTC mais sans indicateur de fuseau :
 * "2026-09-27 20:01:56". `new Date()` les lirait en heure locale (décalage de 1 à 2 h en France).
 * On les marque explicitement comme UTC.
 */
export function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
