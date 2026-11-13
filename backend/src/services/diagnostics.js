// @ts-check
/**
 * Service de diagnostic serveur :
 *  - spark (détection intégrée Paper/Purpur 1.21+, installation via Modrinth, profilage / heapsummary via RCON + logs)
 *  - rapports de crash (crash-reports/*.txt) et journaux (logs/latest.log, logs/*.log.gz) + résumé automatique
 *  - partage sécurisé sur mclo.gs (+ récupération des insights)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const modrinthInstall = require('./modrinthInstall');
const dockerService = require('./docker');
const rcon = require('./rcon');
const { resolveSafe } = require('../routes/servers/files');

/** @typedef {import('../types').ServerRow} ServerRow */
/** @typedef {import('../types').HttpError} HttpError */

const MAX_READ_BYTES = 2 * 1024 * 1024;          // 2 Mo max pour la lecture dans l'UI
const MAX_GZ_DECOMPRESS_BYTES = 32 * 1024 * 1024; // garde-fou anti zip-bomb
const MAX_SHARE_BYTES = 10 * 1024 * 1024;        // 10 Mo max pour mclo.gs
const MCLOGS_API = 'https://api.mclo.gs/1';
const HTTP_TIMEOUT_MS = 20_000;
const UA = { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' };
const SPARK_URL_RE = /https?:\/\/spark\.lucko\.me\/[^\s"'<>)\]]+/i;
const DIAGNOSTIC_NAME_RE = /^(crash-reports\/[^/]+\.txt|logs\/(latest\.log|[^/]+\.log\.gz))$/;

// Paquets et modules cœur ignorés lors de la recherche d'un mod coupable dans une stacktrace
const CORE_MODULES = new Set([
  'minecraft', 'forge', 'neoforge', 'fmlcore', 'javafmllanguage', 'lowcodelanguage',
  'mclanguage', 'modlauncher', 'securejarhandler', 'bootstraplauncher',
]);
const CORE_PACKAGE_PREFIXES = [
  'java.', 'javax.', 'sun.', 'jdk.', 'com.sun.',
  'net.minecraft.', 'com.mojang.', 'io.netty.', 'org.apache.', 'com.google.',
  'org.slf4j.', 'org.lwjgl.', 'it.unimi.', 'org.spongepowered.', 'cpw.mods.',
  'net.minecraftforge.', 'net.neoforged.', 'net.fabricmc.', 'org.quiltmc.',
  'io.papermc.', 'com.destroystokyo.', 'org.bukkit.', 'org.spigotmc.',
];
const CORE_JAR_RE = /^(?:server|minecraft|forge|neoforge|paper|purpur|spigot|bukkit|fabric-loader|quilt-loader)(?:[-_.]|$)/i;

/** Paramètres ajustables dans les tests unitaires. */
const _internals = {
  profileTimeoutMs: 120_000,
};

/** @type {Map<string, { status: 'idle'|'running'|'done'|'error', kind: 'profiler'|'heap'|null, startedAt: number|null, finishedAt?: number|null, url: string|null, error: string|null }>} */
const sparkStates = new Map();

/**
 * Construit une HttpError.
 * @param {number} status
 * @param {string} message
 * @param {boolean} [expose=true]
 * @returns {HttpError}
 */
function httpError(status, message, expose = true) {
  /** @type {HttpError} */
  const err = new Error(message);
  err.status = status;
  err.expose = expose;
  return err;
}

/** @param {string} serverId */
function serverDirOf(serverId) {
  const dataPath = process.env.DATA_PATH || '/data';
  return path.join(dataPath, 'servers', serverId, 'server');
}

/**
 * Vrai si la version Minecraft est >= 1.21 (inclut le schéma annuel 26.x+).
 * Paper et Purpur 1.21+ embarquent déjà spark nativement.
 * @param {string | null | undefined} mcVersion
 * @returns {boolean}
 */
function isAtLeastMc121(mcVersion) {
  if (!mcVersion || typeof mcVersion !== 'string') return false;
  const parts = mcVersion.trim().replace(/-.*$/, '').split('.').map(n => parseInt(n, 10));
  if (parts.some(n => Number.isNaN(n))) return false;
  const [major, minor = 0] = parts;
  if (major >= 26 || major > 1) return true;
  return major === 1 && minor >= 21;
}

/**
 * Retourne l'état courant du profilage spark pour un serveur.
 * @param {string} serverId
 */
function getSparkProfileState(serverId) {
  return sparkStates.get(serverId) || {
    status: 'idle',
    kind: null,
    startedAt: null,
    finishedAt: null,
    url: null,
    error: null,
  };
}

/**
 * Indique si spark est installé (ou intégré à Paper/Purpur 1.21+).
 * @param {ServerRow} server
 */
function getSparkStatus(server) {
  const loader = (server.loader_type || '').toLowerCase();
  const mcVersion = modrinthInstall.mcVersionOf(server) || server.mc_version || null;
  const target = modrinthInstall.targetFor(server);

  if (['paper', 'purpur'].includes(loader) && isAtLeastMc121(mcVersion)) {
    return {
      installed: true,
      builtin: true,
      file: null,
      dir: 'plugins',
      canInstall: false,
      reason: null,
      state: getSparkProfileState(server.id),
    };
  }

  if (target.error) {
    return {
      installed: false,
      builtin: false,
      file: null,
      dir: null,
      canInstall: false,
      reason: target.error,
      state: getSparkProfileState(server.id),
    };
  }

  const dir = path.join(serverDirOf(server.id), target.dir);
  const file = modrinthInstall.findInstalled(dir, 'spark');
  return {
    installed: Boolean(file),
    builtin: false,
    file: file || null,
    dir: target.dir,
    canInstall: !file,
    reason: null,
    state: getSparkProfileState(server.id),
  };
}

/**
 * Installe spark via Modrinth si absent (sauf Paper/Purpur 1.21+ où il est intégré).
 * @param {ServerRow} server
 */
async function installSpark(server) {
  const current = getSparkStatus(server);
  if (current.builtin) {
    return {
      installed: false,
      builtin: true,
      file: null,
      dir: 'plugins',
      restartRequired: false,
    };
  }
  const result = await modrinthInstall.ensureProject(server, 'spark');
  const restartRequired = Boolean(result.installed && ['running', 'starting'].includes(server.status));
  return {
    ...result,
    builtin: false,
    restartRequired,
  };
}

/**
 * Extrait une URL spark.lucko.me d'une ligne ou d'un texte.
 * @param {string} text
 * @returns {string | null}
 */
function extractSparkUrl(text) {
  if (!text) return null;
  const m = String(text).match(SPARK_URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, '');
}

/**
 * Lance un profilage spark (`profiler` 60s ou `heap` heapsummary) via RCON
 * et surveille les logs du container jusqu'à recevoir l'URL spark.lucko.me.
 * @param {ServerRow} server
 * @param {'profiler'|'heap'} kind
 * @param {{ io?: any, timeoutMs?: number }} [opts]
 */
async function runSparkProfile(server, kind, { io = null, timeoutMs } = {}) {
  if (kind !== 'profiler' && kind !== 'heap') {
    throw httpError(400, '«kind» doit être parmi : profiler, heap');
  }
  if (server.status !== 'running') {
    throw httpError(400, 'Le serveur doit être en ligne pour lancer un profilage spark');
  }
  if (!server.container_id) {
    throw httpError(400, 'Container Docker introuvable');
  }

  const prev = sparkStates.get(server.id);
  if (prev?.status === 'running') {
    throw httpError(409, 'Un profilage spark est déjà en cours sur ce serveur');
  }

  const startedAt = Date.now();
  const emitState = (patch) => {
    const nextState = {
      status: patch.status,
      kind,
      startedAt,
      finishedAt: patch.finishedAt ?? null,
      url: patch.url ?? null,
      error: patch.error ?? null,
    };
    sparkStates.set(server.id, nextState);
    io?.to(`server:${server.id}`).emit('diagnostics:spark', {
      serverId: server.id,
      ...nextState,
    });
    return nextState;
  };

  emitState({ status: 'running' });

  const command = kind === 'profiler'
    ? 'spark profiler start --timeout 60'
    : 'spark heapsummary';
  const waitMs = timeoutMs ?? _internals.profileTimeoutMs;
  const since = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopStream = null;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (stopStream) {
        try { stopStream(); } catch { /* ignore */ }
        stopStream = null;
      }
    };

    const succeed = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      const state = emitState({ status: 'done', finishedAt: Date.now(), url });
      resolve({ ok: true, kind, url, state });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const msg = err?.message || 'Erreur lors du profilage spark';
      emitState({ status: 'error', finishedAt: Date.now(), error: msg });
      reject(err);
    };

    timer = setTimeout(() => {
      fail(httpError(504, 'Délai d\'attente dépassé : aucune URL spark reçue dans les logs'));
    }, waitMs);

    // Surveille les logs dès maintenant pour ne manquer aucune ligne émise juste après la commande RCON
    stopStream = dockerService.streamContainerLogs(
      server.container_id,
      (line) => {
        const url = extractSparkUrl(line);
        if (url) succeed(url);
      },
      (err) => {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (!/** @type {HttpError} */ (wrapped).status) {
          /** @type {HttpError} */ (wrapped).status = 502;
        }
        /** @type {HttpError} */ (wrapped).expose = true;
        fail(wrapped);
      },
      () => {
        fail(httpError(502, 'Le flux de logs s\'est arrêté avant la fin du profilage spark'));
      },
      { since }
    );

    // Si le mock a déjà résolu de manière synchrone avant le retour de streamContainerLogs
    if (settled) {
      cleanup();
      return;
    }

    rcon.sendCommand(server, command)
      .then((resp) => {
        if (settled) return;
        if (/Unknown (?:or incomplete )?command/i.test(resp || '')) {
          fail(httpError(400, 'Commande spark inconnue — vérifiez que spark est installé et redémarrez le serveur'));
          return;
        }
        const directUrl = extractSparkUrl(resp);
        if (directUrl) succeed(directUrl);
      })
      .catch((err) => {
        if (settled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        if (!/** @type {HttpError} */ (e).status) /** @type {HttpError} */ (e).status = 502;
        /** @type {HttpError} */ (e).expose = true;
        fail(e);
      });
  });
}

/**
 * Liste les rapports de crash (`crash-reports/*.txt`) et journaux (`logs/latest.log`, `logs/*.log.gz`).
 * @param {string} serverId
 */
function listDiagnosticFiles(serverId) {
  const root = serverDirOf(serverId);
  const crashReports = [];
  const logs = [];

  const crashDir = path.join(root, 'crash-reports');
  if (fs.existsSync(crashDir)) {
    for (const entry of fs.readdirSync(crashDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !/\.txt$/i.test(entry.name)) continue;
      const full = path.join(crashDir, entry.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      crashReports.push({
        name: `crash-reports/${entry.name}`,
        filename: entry.name,
        kind: /** @type {const} */ ('crash'),
        size: st.size,
        mtime: st.mtimeMs,
        compressed: false,
      });
    }
  }
  crashReports.sort((a, b) => (b.mtime - a.mtime) || b.filename.localeCompare(a.filename));

  const logsDir = path.join(root, 'logs');
  if (fs.existsSync(logsDir)) {
    for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const isLatest = entry.name === 'latest.log';
      const isGz = /\.log\.gz$/i.test(entry.name);
      if (!isLatest && !isGz) continue;
      const full = path.join(logsDir, entry.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      logs.push({
        name: `logs/${entry.name}`,
        filename: entry.name,
        kind: /** @type {const} */ ('log'),
        size: st.size,
        mtime: st.mtimeMs,
        compressed: isGz,
      });
    }
  }
  logs.sort((a, b) => {
    const diff = b.mtime - a.mtime;
    if (diff !== 0) return diff;
    if (a.filename === 'latest.log') return -1;
    if (b.filename === 'latest.log') return 1;
    return b.filename.localeCompare(a.filename);
  });

  return { crashReports, logs };
}

/**
 * Vérifie qu'un nom demandé est bien dans la liste blanche des fichiers de diagnostic et sûr.
 * @param {string} serverId
 * @param {string} name
 */
function resolveListedFile(serverId, name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw httpError(400, '«name» requis');
  }
  const root = serverDirOf(serverId);
  // Bloque toute traversée (« .. ») ou évasion par lien symbolique
  const abs = resolveSafe(root, name);
  const normalized = name.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!DIAGNOSTIC_NAME_RE.test(normalized)) {
    throw httpError(403, 'Accès refusé : fichier non autorisé');
  }
  const { crashReports, logs } = listDiagnosticFiles(serverId);
  const entry = [...crashReports, ...logs].find(f => f.name === normalized);
  if (!entry) {
    throw httpError(404, 'Fichier introuvable');
  }
  return { entry, abs };
}

/**
 * Lit et décompresse un fichier de diagnostic (jusqu'à maxOutputLength).
 * @param {string} abs
 * @param {boolean} compressed
 * @param {number} maxDecompress
 */
function readTextFromFile(abs, compressed, maxDecompress = MAX_GZ_DECOMPRESS_BYTES) {
  const raw = fs.readFileSync(abs);
  if (!compressed) return raw.toString('utf8');
  try {
    return zlib.gunzipSync(raw, { maxOutputLength: maxDecompress }).toString('utf8');
  } catch (err) {
    throw httpError(422, `Impossible de décompresser l'archive : ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * Tronque proprement une chaîne UTF-8 à `maxBytes` octets sans couper un point de code.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  let sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
  return { text: sliced, truncated: true };
}

/**
 * Extrait un résumé d'un rapport de crash Minecraft :
 *  - description (« Description: … »)
 *  - première exception Java
 *  - première ligne « at » appartenant à un mod identifiable
 * @param {string} text
 */
function summarizeCrashReport(text) {
  if (!text || typeof text !== 'string') return null;

  const descMatch = text.match(/^Description:\s*(.+)$/m);
  const description = descMatch ? descMatch[1].trim() : null;

  const lines = text.split(/\r?\n/);
  const startIdx = descMatch ? Math.max(0, lines.findIndex(l => /^Description:\s*/.test(l)) + 1) : 0;

  let exception = null;
  let exceptionLineIdx = -1;
  const exRe = /^(?:Caused by:\s*)?([a-z_][\w$]*(?:\.[a-z_][\w$]*)*\.[A-Z][\w$]*)(?::\s*(.*))?$/;
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // Ignorer les lignes indentées (stacktrace) ou commentaires/en-têtes
    if (/^\s/.test(lines[i]) || /^(-{2,}|\/\/|Time:|Description:)/.test(trimmed)) continue;
    const m = trimmed.match(exRe);
    if (!m) continue;
    const cls = m[1];
    const nextNonEmpty = lines.slice(i + 1).find(l => l.trim().length > 0) || '';
    if (/(Exception|Error|Throwable)$/.test(cls) || /^\s*at\s+/.test(nextNonEmpty)) {
      exception = trimmed;
      exceptionLineIdx = i;
      break;
    }
  }

  let mod = null;
  let atLine = null;
  const atStart = exceptionLineIdx >= 0 ? exceptionLineIdx + 1 : startIdx;
  for (let i = atStart; i < lines.length; i++) {
    const m = lines[i].match(/^\s*at\s+(.+)$/);
    if (!m) continue;
    const frame = m[1].trim();
    const identified = identifyModFromFrame(frame);
    if (identified) {
      mod = identified;
      atLine = `at ${frame}`;
      break;
    }
  }

  if (!description && !exception && !atLine) return null;
  return { description, exception, mod, atLine };
}

/**
 * Détermine si une frame `at ...` appartient à un mod tiers identifiable, ou null si cœur/JVM.
 * @param {string} frame
 * @returns {string | null}
 */
function identifyModFromFrame(frame) {
  // 1. Préfixe module Java 17+ : TRANSFORMER/modid@1.2.3/pkg.Class.method(...)
  const modPrefix = frame.match(/^(?:TRANSFORMER|MC-BOOTSTRAP|PLUGIN)\/([^/@]+)@[^/]*\/(.+)$/);
  if (modPrefix) {
    const modId = modPrefix[1];
    if (!CORE_MODULES.has(modId.toLowerCase()) && !modId.startsWith('java.') && !modId.startsWith('jdk.')) {
      return modId;
    }
    return null;
  }

  // 2. Suffixe jar Forge/NeoForge/Paper : ... ~[create-1.21.1.jar%23142!/:?]
  const jarMatch = frame.match(/~?\[([^/\]]+\.jar)[^/\]]*\]/i);
  if (jarMatch && !CORE_JAR_RE.test(jarMatch[1])) {
    return jarMatch[1];
  }

  // 3. Nom de classe standard (avec éventuel classloader knot// ou app//)
  const clsPart = frame.replace(/^[a-z0-9_-]+\/\//i, '').split('(')[0];
  const isCorePkg = CORE_PACKAGE_PREFIXES.some(prefix => clsPart.startsWith(prefix));
  if (isCorePkg) return null;

  const segs = clsPart.split('.');
  if (segs.length >= 3) {
    // Ex: com.simibubi.create.content... → com.simibubi.create
    return segs.slice(0, Math.min(3, segs.length - 1)).join('.');
  }
  return segs[0] || null;
}

/**
 * Lit un rapport de crash ou un log (texte ≤ 2 Mo ; .gz décompressé).
 * @param {string} serverId
 * @param {string} name
 */
function readDiagnosticFile(serverId, name) {
  const { entry, abs } = resolveListedFile(serverId, name);
  const fullText = readTextFromFile(abs, entry.compressed, MAX_GZ_DECOMPRESS_BYTES);
  const summary = entry.kind === 'crash' ? summarizeCrashReport(fullText) : null;
  const { text: content, truncated } = truncateUtf8(fullText, MAX_READ_BYTES);
  return {
    ...entry,
    content,
    truncated,
    summary,
  };
}

/**
 * Partage un rapport de crash ou un log sur mclo.gs (max 10 Mo, tronqué au-delà)
 * et récupère l'analyse (insights) si disponible.
 * @param {string} serverId
 * @param {string} name
 */
async function shareDiagnosticFile(serverId, name) {
  const { entry, abs } = resolveListedFile(serverId, name);
  const fullText = readTextFromFile(abs, entry.compressed, MAX_GZ_DECOMPRESS_BYTES * 2);
  if (!fullText.trim()) {
    throw httpError(400, 'Ce fichier est vide et ne peut pas être partagé');
  }

  const { text: payloadText, truncated } = truncateUtf8(fullText, MAX_SHARE_BYTES);
  const body = new URLSearchParams({ content: payloadText }).toString();

  const { data } = await axios.post(`${MCLOGS_API}/log`, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...UA,
    },
    timeout: HTTP_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (!data?.success || !data?.url) {
    throw httpError(502, data?.error || 'Échec du partage sur mclo.gs');
  }

  let insights = null;
  if (data.id) {
    try {
      const ins = await axios.get(`${MCLOGS_API}/insights/${encodeURIComponent(data.id)}`, {
        headers: UA,
        timeout: HTTP_TIMEOUT_MS,
      });
      if (ins?.data) insights = ins.data;
    } catch {
      insights = null;
    }
  }

  return {
    ok: true,
    name: entry.name,
    id: data.id || null,
    url: data.url,
    raw: data.raw || null,
    truncated,
    insights,
  };
}

module.exports = {
  getSparkStatus,
  getSparkProfileState,
  installSpark,
  runSparkProfile,
  listDiagnosticFiles,
  readDiagnosticFile,
  shareDiagnosticFile,
  summarizeCrashReport,
  isAtLeastMc121,
  extractSparkUrl,
  MAX_READ_BYTES,
  MAX_SHARE_BYTES,
  _internals,
};
