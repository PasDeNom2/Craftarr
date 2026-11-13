// Sauvegardes hors site incrémentales et dédupliquées via restic (S3, SFTP, REST, dossier local).
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../config/database');
const appSettings = require('./appSettings');
const backupService = require('./backup');
const serverLock = require('./serverLock');
const notify = require('./notify');

appSettings.register('offsite_repository');
appSettings.register('offsite_password', { secret: true });
appSettings.register('offsite_env', { secret: true });
appSettings.register('offsite_keep_daily');
appSettings.register('offsite_keep_weekly');
appSettings.register('offsite_keep_monthly');

const CONFIG_FILES = ['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'server.properties', 'usercache.json'];
const CONFIG_DIRS = ['plugins', 'config'];

const RESTIC_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 h
const RESTIC_MAX_BUFFER = 10 * 1024 * 1024;   // 10 Mo max en sortie

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'RESTIC_REPOSITORY',
  'RESTIC_PASSWORD',
  'RESTIC_PASSWORD_FILE',
  'RESTIC_PASSWORD_COMMAND',
]);

const KEEP_DEFAULTS = { daily: 7, weekly: 4, monthly: 6 };

/**
 * Masque les identifiants qui pourraient apparaître dans les messages de restic (enregistrés en
 * base et affichés) : « user:motdepasse@ » dans une URL de dépôt, et les valeurs secrètes connues.
 */
function redactSecrets(text) {
  let out = String(text).replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@');
  for (const key of ['offsite_password', 'offsite_env']) {
    let secret = null;
    try { secret = require('./appSettings').get(key); } catch { /* base indisponible */ }
    if (!secret) continue;
    const values = key === 'offsite_env'
      ? secret.split('\n').map(l => l.split('=').slice(1).join('=').trim()).filter(v => v.length >= 6)
      : [secret];
    for (const v of values) out = out.split(v).join('***');
  }
  return out;
}

function getDataPath() {
  return process.env.DATA_PATH || '/data';
}

function isValidSnapshotId(id) {
  return typeof id === 'string' && SNAPSHOT_ID_RE.test(id);
}

/**
 * Parse les variables d'environnement supplémentaires (format CLE=valeur, une par ligne).
 * Ignore les lignes vides, commentaires et clés invalides ou dangereuses.
 */
function parseOffsiteEnv(raw) {
  const env = {};
  if (!raw || typeof raw !== 'string') return env;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1);
    if (!ENV_KEY_RE.test(key) || BLOCKED_ENV_KEYS.has(key)) continue;
    if (val.includes('\0')) continue;
    env[key] = val;
  }
  return env;
}

/** Filtre un texte CLE=valeur pour ne conserver que les lignes valides. */
function sanitizeEnvText(raw) {
  const parsed = parseOffsiteEnv(raw);
  return Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('\n');
}

function getKeep(period) {
  const def = KEEP_DEFAULTS[period];
  const raw = appSettings.get(`offsite_keep_${period}`);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

function isConfigured() {
  return Boolean(appSettings.get('offsite_repository') && appSettings.get('offsite_password'));
}

function getResticConfig() {
  const repository = appSettings.get('offsite_repository');
  const password = appSettings.get('offsite_password');
  if (!repository || !password) {
    throw Object.assign(new Error('Dépôt hors site ou mot de passe non configuré'), { status: 400 });
  }
  const extraEnv = parseOffsiteEnv(appSettings.get('offsite_env'));
  const env = {
    ...process.env,
    ...extraEnv,
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD: password,
  };
  return { repository, env };
}

/**
 * Exécute restic sans shell, avec arguments en tableau, env isolé, timeout 6 h et sortie bornée.
 */
function execRestic(args, extraOpts = {}) {
  const { env } = getResticConfig();
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'restic',
      args,
      {
        env,
        timeout: RESTIC_TIMEOUT_MS,
        maxBuffer: RESTIC_MAX_BUFFER,
        shell: false,
        ...extraOpts,
      },
      (err, stdout, stderr) => {
        const outStr = stdout ? stdout.toString() : '';
        const errStr = stderr ? stderr.toString() : '';
        if (err) {
          const detail = redactSecrets((errStr || outStr || err.message || 'Erreur restic').trim());
          const wrapped = Object.assign(new Error(detail.slice(0, 500)), {
            code: err.code,
            stderr: errStr,
            stdout: outStr,
            expose: true,
          });
          return reject(wrapped);
        }
        resolve({ stdout: outStr, stderr: errStr });
      }
    );
  });
}

function parseJsonLines(stdout) {
  const items = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Ignorer les lignes non-JSON éventuelles
    }
  }
  return items;
}

/** Vérifie l'accès au dépôt via `restic cat config`. */
async function test() {
  await execRestic(['cat', 'config', '--json']);
  return { ok: true };
}

/** Initialise le dépôt restic s'il n'existe pas encore (détection via `restic cat config`). */
async function init() {
  try {
    await execRestic(['cat', 'config', '--json']);
    return { ok: true, alreadyInitialized: true };
  } catch (err) {
    const msg = `${err.message || ''} ${err.stderr || ''}`;
    if (/wrong password|invalid.*key|permission denied|access denied|forbidden|unauthorized|connection refused|timeout/i.test(msg)) {
      throw err;
    }
    await execRestic(['init', '--json']);
    return { ok: true, alreadyInitialized: false };
  }
}

/** Liste les snapshots restic d'un serveur (triés du plus récent au plus ancien). */
async function listSnapshots(serverId) {
  const { stdout } = await execRestic(['snapshots', '--json', '--tag', `server:${serverId}`]);
  const raw = String(stdout || '').trim();
  if (!raw || raw === 'null') return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(s => ({
      id: s.id,
      short_id: s.short_id || String(s.id || '').slice(0, 8),
      time: s.time,
      hostname: s.hostname,
      tags: Array.isArray(s.tags) ? s.tags : [],
      paths: Array.isArray(s.paths) ? s.paths : [],
      size: s.summary?.total_bytes_processed ?? s.size ?? null,
    }))
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

function collectBackupItems(serverDir) {
  const candidates = [...backupService.getWorldDirs(serverDir), ...CONFIG_FILES, ...CONFIG_DIRS];
  return candidates.filter(item => fs.existsSync(path.join(serverDir, item)));
}

/**
 * Sauvegarde un serveur vers le dépôt restic puis applique la politique de rétention.
 */
async function backupServer(server) {
  getResticConfig();
  const db = getDb();
  const serverDir = path.join(getDataPath(), 'servers', server.id, 'server');
  const items = collectBackupItems(serverDir);

  const insert = db.prepare("INSERT INTO offsite_runs (server_id, status) VALUES (?, 'running')").run(server.id);
  const runId = insert.lastInsertRowid;

  try {
    if (!items.length) {
      throw Object.assign(new Error('Aucun fichier de monde ou de configuration à sauvegarder'), { status: 400 });
    }

    const backupArgs = [
      'backup',
      '--json',
      '--tag', 'craftarr',
      '--tag', `server:${server.id}`,
      '--host', 'craftarr',
      ...items,
    ];

    const { stdout } = await backupService.withWorldFlushed(server, () =>
      execRestic(backupArgs, { cwd: serverDir })
    );

    const events = parseJsonLines(stdout);
    const summary = [...events].reverse().find(e => e.message_type === 'summary' || e.snapshot_id);
    const snapshotId = summary?.snapshot_id || null;
    const addedBytes = Number(summary?.data_added ?? 0) || 0;

    const forgetArgs = [
      'forget',
      '--json',
      '--tag', `server:${server.id}`,
      '--keep-daily', String(getKeep('daily')),
      '--keep-weekly', String(getKeep('weekly')),
      '--keep-monthly', String(getKeep('monthly')),
      '--prune',
    ];
    await execRestic(forgetArgs);

    db.prepare(`
      UPDATE offsite_runs
      SET finished_at = datetime('now'), status = 'success', snapshot_id = ?, added_bytes = ?, message = NULL
      WHERE id = ?
    `).run(snapshotId, addedBytes, runId);

    return { runId, snapshotId, addedBytes };
  } catch (err) {
    db.prepare(`
      UPDATE offsite_runs
      SET finished_at = datetime('now'), status = 'failed', message = ?
      WHERE id = ?
    `).run(String(err.message || 'Erreur inconnue').slice(0, 500), runId);

    notify.notify({
      serverName: server.name,
      level: 'error',
      title: 'Sauvegarde hors site en échec',
      message: err.message,
    });
    throw err;
  }
}

/**
 * Restaure un snapshot restic dans un dossier de staging puis applique la même bascule
 * sécurisée que backupService.restoreBackup, sous serverLock.withLock.
 */
async function restoreSnapshot(server, snapshotId) {
  if (!isValidSnapshotId(snapshotId)) {
    throw Object.assign(new Error('Identifiant de snapshot invalide'), { status: 400 });
  }
  getResticConfig();

  // Le snapshot doit appartenir à ce serveur (tag server:<id>) : pas de restauration croisée.
  const owned = await listSnapshots(server.id);
  if (!owned.some(s => typeof s.id === 'string' && s.id.startsWith(snapshotId))) {
    throw Object.assign(new Error('Snapshot introuvable pour ce serveur'), { status: 404 });
  }

  return serverLock.withLock(server.id, 'restauration hors site', async () => {
    const dockerService = require('./docker');
    const db = getDb();
    const serverDir = path.join(getDataPath(), 'servers', server.id, 'server');
    const stagingDir = path.join(getDataPath(), 'servers', server.id, '.offsite-restore-staging');

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      await execRestic(['restore', snapshotId, '--json', '--target', stagingDir]);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      notify.notify({
        serverName: server.name,
        level: 'error',
        title: 'Restauration hors site en échec',
        message: err.message,
      });
      throw err;
    }

    if (server.container_id) {
      try { await dockerService.stopContainer(server.container_id); } catch {}
    }
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);

    try {
      const worldDirs = backupService.getWorldDirs(serverDir);
      const items = [...worldDirs, ...CONFIG_FILES, ...CONFIG_DIRS];

      let sourceRoot = stagingDir;
      const hasDirect = items.some(item => fs.existsSync(path.join(stagingDir, item)));
      if (!hasDirect) {
        const nested = path.join(stagingDir, serverDir.replace(/^\/+/, ''));
        if (fs.existsSync(nested)) sourceRoot = nested;
      }

      const restoredWorlds = worldDirs.filter(d => fs.existsSync(path.join(sourceRoot, d)));
      if (restoredWorlds.length) {
        for (const d of worldDirs) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
      }
      fs.mkdirSync(serverDir, { recursive: true });
      backupService.swapInFromStaging(sourceRoot, serverDir, items);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (server.container_id) {
      await dockerService.startContainer(server.container_id, server);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    }
  });
}

// ─── File d'attente globale : une seule exécution restic à la fois ────────────
let queueTail = Promise.resolve();
const activeCounts = new Map();

function isServerActive(serverId) {
  return (activeCounts.get(serverId) || 0) > 0;
}

function enqueueBackup(server) {
  activeCounts.set(server.id, (activeCounts.get(server.id) || 0) + 1);
  // Relire le serveur au moment de l'exécution (statut à jour pour withWorldFlushed).
  const task = () => {
    const fresh = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    return backupServer(fresh || server);
  };
  const run = queueTail.then(task, task).finally(() => {
    const next = (activeCounts.get(server.id) || 1) - 1;
    if (next <= 0) activeCounts.delete(server.id);
    else activeCounts.set(server.id, next);
  });
  queueTail = run.catch(() => {});
  return run;
}

module.exports = {
  redactSecrets,
  init,
  backupServer,
  enqueueBackup,
  listSnapshots,
  restoreSnapshot,
  test,
  parseOffsiteEnv,
  sanitizeEnvText,
  isValidSnapshotId,
  getKeep,
  isConfigured,
  isServerActive,
  _internals: { CONFIG_FILES, CONFIG_DIRS, ENV_KEY_RE, SNAPSHOT_ID_RE },
};
