// Extension : veille automatique (autopause / autostop itzg) et routage par sous-domaine (mc-router).
const { getDb } = require('../../config/database');
const appSettings = require('../appSettings');
const validate = require('../validate');

appSettings.register('router_enabled');
appSettings.register('router_domain');

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9]{2,59})$/;
const SLEEP_CACHE_TTL_MS = 30_000;

/** Cache par containerId : { sleeping: boolean, checkedAt: number, pending: boolean } */
const sleepCache = new Map();

/** Transforme un nom de serveur en sous-domaine DNS valide (1 à 63 caractères). */
function slugify(name) {
  const s = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return s || 'server';
}

/** Retourne le sous-domaine configuré ou le slug du nom du serveur. */
function effectiveHostname(server) {
  return server?.hostname || slugify(server?.name || server?.id?.slice(0, 8));
}

/** Valide un nom de domaine DNS (ex. mc.exemple.fr). */
function isValidDomain(domain) {
  if (typeof domain !== 'string') return false;
  const s = domain.trim().toLowerCase();
  if (!s || s.length > 253) return false;
  return DOMAIN_RE.test(s);
}

/** État courant du routeur depuis les réglages globaux. */
function getRouterConfig() {
  const enabled = appSettings.get('router_enabled') === '1';
  const domain = (appSettings.get('router_domain') || '').trim().toLowerCase();
  return { enabled, domain, active: enabled && !!domain };
}

/** Détermine si une ligne de log itzg indique que le processus Java est en pause. */
function isAutopauseLine(line) {
  if (!line) return false;
  if (/pausing java process/i.test(line)) return true;
  return /autopause/i.test(line) && !/resum|unpaus|wak/i.test(line);
}

/** Rafraîchit l'état de veille d'un container via les 50 dernières lignes de log. */
async function refreshSleepCache(containerId) {
  try {
    const dockerService = require('../docker');
    const lines = await dockerService.getRecentLogs(containerId, 50);
    const last = Array.isArray(lines) && lines.length ? String(lines[lines.length - 1]) : '';
    sleepCache.set(containerId, { sleeping: isAutopauseLine(last), checkedAt: Date.now(), pending: false });
  } catch {
    const prev = sleepCache.get(containerId);
    sleepCache.set(containerId, { sleeping: prev?.sleeping ?? false, checkedAt: Date.now(), pending: false });
  }
}

/** Valide et vérifie l'unicité d'un sous-domaine serveur. */
function parseHostname(value, server) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('«hostname» doit être une chaîne de caractères'), { status: 400 });
  }
  const s = value.trim();
  if (!HOSTNAME_RE.test(s)) {
    throw Object.assign(
      new Error('«hostname» invalide (minuscules, chiffres et tirets, 1 à 63 caractères)'),
      { status: 400 }
    );
  }
  try {
    // Un serveur peut renvoyer son propre sous-domaine sans conflit
    const existing = getDb().prepare('SELECT id FROM servers WHERE hostname = ? AND id != ?').get(s, server?.id || '');
    if (existing) {
      throw Object.assign(new Error(`Le sous-domaine « ${s} » est déjà utilisé`), { status: 409 });
    }
  } catch (err) {
    if (err.status) throw err;
  }
  return s;
}

function env(server) {
  if (server.pregen_enabled) return [];
  const sec = Math.max(1, Number(server.sleep_after_minutes) || 10) * 60;
  if (server.sleep_mode === 'pause') {
    return [
      'ENABLE_AUTOPAUSE=TRUE',
      `AUTOPAUSE_TIMEOUT_EST=${sec}`,
      `AUTOPAUSE_TIMEOUT_INIT=${sec}`,
      'MAX_TICK_TIME=-1',
    ];
  }
  if (server.sleep_mode === 'stop') {
    return [
      'ENABLE_AUTOSTOP=TRUE',
      `AUTOSTOP_TIMEOUT_EST=${sec}`,
      `AUTOSTOP_TIMEOUT_INIT=${sec}`,
    ];
  }
  return [];
}

function hostConfig(server) {
  if (server.sleep_mode === 'stop' && !server.pregen_enabled) {
    return { RestartPolicy: { Name: 'on-failure' } };
  }
  return {};
}

function labels(server) {
  const { active, domain } = getRouterConfig();
  if (!active) return {};
  return {
    'mc-router.host': `${effectiveHostname(server)}.${domain}`,
    'mc-router.port': '25565',
  };
}

function publishGamePort() {
  return !getRouterConfig().active;
}

const fields = {
  sleep_mode: {
    parse: v => validate.oneOf(v, ['off', 'pause', 'stop'], 'sleep_mode'),
    container: true,
  },
  sleep_after_minutes: {
    parse: v => validate.int(v, { min: 1, max: 120, field: 'sleep_after_minutes' }),
    container: true,
  },
  hostname: {
    parse: parseHostname,
    container: true,
  },
};

function decorate(row) {
  const { active, domain } = getRouterConfig();
  const join_address = active ? `${effectiveHostname(row)}.${domain}` : null;

  let sleeping = false;
  if (row.status === 'running' && row.sleep_mode === 'pause' && !row.pregen_enabled && row.container_id) {
    const entry = sleepCache.get(row.container_id);
    const now = Date.now();
    if (!entry || (now - entry.checkedAt >= SLEEP_CACHE_TTL_MS && !entry.pending)) {
      sleepCache.set(row.container_id, {
        sleeping: entry?.sleeping ?? false,
        checkedAt: entry?.checkedAt ?? 0,
        pending: true,
      });
      refreshSleepCache(row.container_id);
    }
    sleeping = Boolean(sleepCache.get(row.container_id)?.sleeping);
  } else if (row.container_id && row.status !== 'running') {
    sleepCache.delete(row.container_id);
  }

  // N'ajoute que les champs utiles (n'altère pas la réponse des serveurs sans routeur ni veille)
  const out = {};
  if (join_address) out.join_address = join_address;
  if (sleeping) out.sleeping = true;
  return out;
}

function clearServerSleepCache(serverId) {
  try {
    const row = getDb().prepare('SELECT container_id FROM servers WHERE id = ?').get(serverId);
    if (row?.container_id) sleepCache.delete(row.container_id);
  } catch {}
}

function init({ events } = {}) {
  if (!events?.on) return;
  for (const ev of ['server:stopped', 'server:started', 'server:power', 'player:join']) {
    events.on(ev, ({ serverId }) => clearServerSleepCache(serverId));
  }
}

module.exports = {
  name: 'router-sleep',
  env,
  hostConfig,
  labels,
  publishGamePort,
  fields,
  decorate,
  init,
  _internals: {
    slugify,
    effectiveHostname,
    isValidDomain,
    getRouterConfig,
    isAutopauseLine,
    refreshSleepCache,
    sleepCache,
    SLEEP_CACHE_TTL_MS,
  },
};
