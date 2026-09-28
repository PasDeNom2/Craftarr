import { parseDbDate } from '../../../utils/dates';

/** 3725 → « 1 h 02 », 540 → « 9 min », 42 → « 42 s » */
export function formatDuration(seconds, { short = false } = {}) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (short || h >= 100) return `${h} h`;
  return rm ? `${h} h ${String(rm).padStart(2, '0')}` : `${h} h`;
}

export const formatNumber = n => (n == null ? '—' : Number(n).toLocaleString());

export function formatDistance(meters) {
  if (meters == null) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 1)} km` : `${meters} m`;
}

/** « minecraft:oak_log » → { name: « Oak Log », mod: null } ; « create:cogwheel » → mod « create » */
export function humanizeId(id = '') {
  const [ns, path = ns] = id.includes(':') ? id.split(':') : ['minecraft', id];
  const last = path.split('/').pop();
  const name = last.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { name, mod: ns === 'minecraft' ? null : ns };
}

// Sessions → intervalles [début, fin] en ms (session ouverte = maintenant)
export function sessionRanges(sessions, now = Date.now()) {
  return sessions.map(s => {
    const start = parseDbDate(s.joined_at)?.getTime();
    const end = s.left_at ? parseDbDate(s.left_at)?.getTime() : now;
    return start && end && end > start ? { username: s.username, start, end, reason: s.reason } : null;
  }).filter(Boolean);
}

const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY = 86_400_000;

/**
 * Activité par jour (heure locale) sur les `days` derniers jours :
 * [{ day: Date, seconds, players: Set, sessions }]
 */
export function dailyActivity(ranges, days, now = Date.now()) {
  const first = dayStart(now) - (days - 1) * DAY;
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(first + i * DAY), seconds: 0, players: new Set(), sessions: 0 }));
  for (const r of ranges) {
    const startIdx = Math.floor((dayStart(r.start) - first) / DAY);
    if (startIdx >= 0 && startIdx < days) out[startIdx].sessions++;
    for (let t = Math.max(r.start, first); t < r.end;) {
      const d0 = dayStart(t);
      const idx = Math.round((d0 - first) / DAY);
      const segEnd = Math.min(r.end, d0 + DAY);
      if (idx >= 0 && idx < days) {
        out[idx].seconds += (segEnd - t) / 1000;
        out[idx].players.add(r.username);
      }
      t = segEnd;
    }
  }
  return out;
}

/** Secondes jouées par jour de la semaine (0 = lundi) × heure, sur les intervalles donnés. */
export function weekHeatmap(ranges, since) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of ranges) {
    for (let t = Math.max(r.start, since); t < r.end;) {
      const d = new Date(t);
      const hourEnd = new Date(d); hourEnd.setMinutes(60, 0, 0);
      const segEnd = Math.min(r.end, hourEnd.getTime());
      grid[(d.getDay() + 6) % 7][d.getHours()] += (segEnd - t) / 1000;
      t = segEnd;
    }
  }
  return grid;
}

/** Répartition sur 24 h (secondes par heure). */
export function hourly(ranges) {
  const out = new Array(24).fill(0);
  for (const r of ranges) {
    for (let t = r.start; t < r.end;) {
      const d = new Date(t);
      const hourEnd = new Date(d); hourEnd.setMinutes(60, 0, 0);
      const segEnd = Math.min(r.end, hourEnd.getTime());
      out[d.getHours()] += (segEnd - t) / 1000;
      t = segEnd;
    }
  }
  return out;
}

export const weekdayNames = (locale) => Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'short' }).replace('.', ''));
