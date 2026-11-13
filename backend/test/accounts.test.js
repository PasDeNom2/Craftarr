// Intégration Feature C1 : comptes multiples, permissions par serveur, TOTP 2FA et journal d'activité.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');
const { tmpDir, src } = require('./helpers');
const totp = require(src('services/totp'));

const DATA = tmpDir();
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const env = { ...process.env, DATA_PATH: DATA, PORT: String(PORT), NODE_ENV: 'test' };
delete env.JWT_SECRET;

let proc, out = '', db;
let adminToken, adminId, userToken, userId;
const srv1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const srv2 = 'aaaaaaaa-2222-2222-2222-222222222222';

async function waitFor(re, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = out.match(re);
    if (m) return m;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout en attendant ${re}\n${out}`);
}

function startBackend() {
  out = '';
  proc = spawn(process.execPath, [src('index.js')], { env, cwd: path.join(__dirname, '..') });
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return waitFor(/Backend démarré/);
}

async function req(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

before(async () => { await startBackend(); });
after(() => { proc?.kill(); db?.close(); });

test('setup : premier compte créé en admin avec role dans /auth/me', async () => {
  const setupToken = (await waitFor(/Jeton de configuration : ([0-9A-F]{12})/))[1];
  const setup = await req('POST', '/auth/setup', { username: 'admin', password: 'password123', setupToken });
  assert.strictEqual(setup.status, 200);
  assert.strictEqual(setup.data.role, 'admin');
  assert.ok(setup.data.token);
  adminToken = setup.data.token;

  const me = await req('GET', '/auth/me', null, adminToken);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.username, 'admin');
  assert.strictEqual(me.data.role, 'admin');
  assert.strictEqual(me.data.totp_enabled, false);
  adminId = me.data.id;

  db = new Database(path.join(DATA, 'craftarr.db'));
  for (const [id, name, port, rcon] of [[srv1, 'Alpha', 25611, 25612], [srv2, 'Beta', 25621, 25622]]) {
    db.prepare(`
      INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
      VALUES (?, ?, '1', 'Pack', 'curseforge', ?, ?, 'rconpass', 2048, 10, 'stopped', 'fabric')
    `).run(id, name, port, rcon);
  }
});

test('permissions : rôle user sans droits ne voit ni serveurs ni routes admin', async () => {
  const create = await req('POST', '/users', { username: 'alice', password: 'alicepass1', role: 'user' }, adminToken);
  assert.strictEqual(create.status, 201);
  assert.strictEqual(create.data.role, 'user');
  userId = create.data.id;

  const login = await req('POST', '/auth/login', { username: 'alice', password: 'alicepass1' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.data.role, 'user');
  userToken = login.data.token;

  const me = await req('GET', '/auth/me', null, userToken);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.role, 'user');

  const list = await req('GET', '/servers', null, userToken);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.data, []);

  assert.strictEqual((await req('GET', `/servers/${srv1}`, null, userToken)).status, 403);
  assert.strictEqual((await req('POST', '/servers', { name: 'X', modpack_id: '1', modpack_source: 'curseforge', port: 25630 }, userToken)).status, 403);
  assert.strictEqual((await req('GET', '/settings', null, userToken)).status, 403);
  assert.strictEqual((await req('PATCH', '/settings', {}, userToken)).status, 403);
  assert.strictEqual((await req('DELETE', `/servers/${srv1}`, null, userToken)).status, 403);
  assert.strictEqual((await req('GET', '/users', null, userToken)).status, 403);
  assert.strictEqual((await req('GET', '/activity', null, userToken)).status, 403);
  assert.strictEqual((await req('PUT', `/users/${userId}/servers/${srv1}`, { perms: ['view'] }, userToken)).status, 403);
});

test('permissions granulaires : view puis power sur srv1 uniquement', async () => {
  const grantView = await req('PUT', `/users/${userId}/servers/${srv1}`, { perms: ['view'] }, adminToken);
  assert.strictEqual(grantView.status, 200);
  assert.deepStrictEqual(grantView.data.perms, ['view']);

  const list = await req('GET', '/servers', null, userToken);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.length, 1);
  assert.strictEqual(list.data[0].id, srv1);
  assert.deepStrictEqual(list.data[0].my_perms, ['view']);

  const detail1 = await req('GET', `/servers/${srv1}`, null, userToken);
  assert.strictEqual(detail1.status, 200);
  assert.deepStrictEqual(detail1.data.my_perms, ['view']);
  assert.strictEqual((await req('GET', `/servers/${srv2}`, null, userToken)).status, 403);

  // Sans les permissions dédiées, les sous-ressources sont refusées
  assert.strictEqual((await req('GET', `/servers/${srv1}/files`, null, userToken)).status, 403);
  assert.strictEqual((await req('POST', `/servers/${srv1}/start`, null, userToken)).status, 403);
  assert.strictEqual((await req('POST', `/servers/${srv1}/rcon`, { command: 'list' }, userToken)).status, 403);
  assert.strictEqual((await req('PATCH', `/servers/${srv1}`, { max_players: 12 }, userToken)).status, 403);

  // Ajout de 'power' : /start passe le middleware de permissions (échoue à 400 faute de container Docker, pas 403)
  const grantPower = await req('PUT', `/users/${userId}/servers/${srv1}`, { perms: ['view', 'power'] }, adminToken);
  assert.strictEqual(grantPower.status, 200);

  const startRes = await req('POST', `/servers/${srv1}/start`, null, userToken);
  assert.notStrictEqual(startRes.status, 403);
  assert.strictEqual(startRes.status, 400);
  assert.strictEqual((await req('POST', `/servers/${srv1}/rcon`, { command: 'list' }, userToken)).status, 403);
});

test('contournements de chemin : casse, double slash, slash final, encodage', async () => {
  // L'utilisateur a view+power sur srv1, rien sur srv2 (test précédent)
  const raw = async (method, fullPath, token = userToken) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${fullPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: method === 'GET' ? undefined : '{}',
    });
    return res.status;
  };
  const denied = (st, label) => assert.ok(st === 403 || st === 404 || st === 400, `${label} → ${st}`);

  // Routes admin
  assert.strictEqual(await raw('GET', '/api/Settings'), 403);
  assert.strictEqual(await raw('GET', '/API/SETTINGS'), 403);
  assert.strictEqual(await raw('GET', '/api//settings'), 403);
  assert.strictEqual(await raw('GET', '/api/settings/'), 403);
  assert.strictEqual(await raw('GET', '/api/%73ettings'), 403);
  assert.strictEqual(await raw('GET', '/api/Users'), 403);
  assert.strictEqual(await raw('GET', '/api/Backups/Orphans'), 403);
  assert.strictEqual(await raw('DELETE', `/api/Servers/${srv1}`), 403);
  assert.strictEqual(await raw('DELETE', `/api/servers/${srv1}/`), 403);

  // Serveur sans aucune permission
  for (const p of [`/api/Servers/${srv2}`, `/api//servers/${srv2}`, `/api/servers//${srv2}`, `/api/servers/${srv2}/`,
    `/api/servers/${srv2.toUpperCase()}`, `/api/servers/${encodeURIComponent(srv2).replace('a', '%61')}`]) {
    denied(await raw('GET', p), p);
  }

  // Sous-ressources sans la permission dédiée (srv1 : view+power seulement)
  for (const p of [`/api/servers/${srv1}/RCON`, `/api/servers/${srv1}/%72con`, `/api/servers/${srv1}//rcon`,
    `/api/servers/${srv1}/rcon/`, `/api/SERVERS/${srv1}/Rcon`]) {
    denied(await raw('POST', p), p);
  }
  for (const p of [`/api/servers/${srv1}/Files`, `/api/servers/${srv1}/%66iles`, `/api/servers/${srv1}//files/`,
    `/api/servers/${srv1}/diagnostics/file?name=latest.log`, `/api/servers/${srv1}/Diagnostics/File?name=latest.log`]) {
    denied(await raw('GET', p), p);
  }
  denied(await raw('PATCH', `/api/Servers/${srv1}`), 'PATCH casse');
  denied(await raw('POST', `/api/servers/${srv1}/Schedules`), 'POST schedules casse');
  denied(await raw('POST', `/api/servers/${srv1}%2Fstart`), 'POST %2F');
});

test('admin : accès complet, protection dernier admin, reset mdp et compte désactivé', async () => {
  const adminList = await req('GET', '/servers', null, adminToken);
  assert.strictEqual(adminList.status, 200);
  assert.strictEqual(adminList.data.length, 2);
  assert.ok(Array.isArray(adminList.data[0].my_perms) && adminList.data[0].my_perms.includes('manage'));

  // Impossible de se supprimer, de se rétrograder ou de se désactiver en tant que seul admin
  assert.strictEqual((await req('DELETE', `/users/${adminId}`, null, adminToken)).status, 400);
  assert.strictEqual((await req('PATCH', `/users/${adminId}`, { role: 'user' }, adminToken)).status, 400);
  assert.strictEqual((await req('PATCH', `/users/${adminId}`, { disabled: true }, adminToken)).status, 400);

  // Réinitialisation du mot de passe d'alice -> révoque son ancien token
  const oldUserToken = userToken;
  const reset = await req('PATCH', `/users/${userId}`, { password: 'alicepass2' }, adminToken);
  assert.strictEqual(reset.status, 200);
  assert.strictEqual((await req('GET', '/auth/me', null, oldUserToken)).status, 401);

  const relogin = await req('POST', '/auth/login', { username: 'alice', password: 'alicepass2' });
  assert.strictEqual(relogin.status, 200);
  userToken = relogin.data.token;

  // Désactivation -> token immédiatement rejeté + login refusé (401)
  const disable = await req('PATCH', `/users/${userId}`, { disabled: true }, adminToken);
  assert.strictEqual(disable.status, 200);
  assert.strictEqual(disable.data.disabled, true);
  assert.strictEqual((await req('GET', '/auth/me', null, userToken)).status, 401);
  assert.strictEqual((await req('POST', '/auth/login', { username: 'alice', password: 'alicepass2' })).status, 401);

  // Création puis suppression d'un compte temporaire
  const tmpUser = await req('POST', '/users', { username: 'tempuser', password: 'temppass1', role: 'user' }, adminToken);
  assert.strictEqual(tmpUser.status, 201);
  assert.strictEqual((await req('DELETE', `/users/${tmpUser.data.id}`, null, adminToken)).status, 200);

  // Réactivation
  assert.strictEqual((await req('PATCH', `/users/${userId}`, { disabled: false }, adminToken)).status, 200);
  const afterEnable = await req('POST', '/auth/login', { username: 'alice', password: 'alicepass2' });
  assert.strictEqual(afterEnable.status, 200);
  userToken = afterEnable.data.token;
});

test('2FA TOTP : setup, enable, challenge login, anti-rejeu et code de secours à usage unique', async () => {
  const st0 = await req('GET', '/auth/2fa/status', null, userToken);
  assert.strictEqual(st0.status, 200);
  assert.strictEqual(st0.data.enabled, false);

  const setup = await req('POST', '/auth/2fa/setup', null, userToken);
  assert.strictEqual(setup.status, 200);
  assert.ok(setup.data.secret && setup.data.otpauthUrl.startsWith('otpauth://totp/'));

  const code = totp.generateTotp(setup.data.secret);
  const enable = await req('POST', '/auth/2fa/enable', { code }, userToken);
  assert.strictEqual(enable.status, 200);
  assert.strictEqual(enable.data.ok, true);
  assert.strictEqual(enable.data.recoveryCodes.length, 8);

  const me = await req('GET', '/auth/me', null, userToken);
  assert.strictEqual(me.data.totp_enabled, true);

  // Connexion : demande le 2e facteur au lieu d'émettre le JWT directement
  const login1 = await req('POST', '/auth/login', { username: 'alice', password: 'alicepass2' });
  assert.strictEqual(login1.status, 200);
  assert.strictEqual(login1.data.twoFactorRequired, true);
  assert.ok(login1.data.challenge);
  assert.strictEqual(login1.data.token, undefined);

  // Mauvais code -> 401
  const wrongCode = code === '000000' ? '111111' : '000000';
  assert.strictEqual((await req('POST', '/auth/2fa/verify', { challenge: login1.data.challenge, code: wrongCode })).status, 401);

  // Bon code -> session complète
  const verifyOk = await req('POST', '/auth/2fa/verify', { challenge: login1.data.challenge, code });
  assert.strictEqual(verifyOk.status, 200);
  assert.ok(verifyOk.data.token);
  assert.strictEqual(verifyOk.data.role, 'user');

  // Rejeu immédiat du même code TOTP sur le même pas -> 401
  const replay = await req('POST', '/auth/2fa/verify', { challenge: login1.data.challenge, code });
  assert.strictEqual(replay.status, 401);

  // Code de secours à usage unique
  const login2 = await req('POST', '/auth/login', { username: 'alice', password: 'alicepass2' });
  assert.strictEqual(login2.data.twoFactorRequired, true);
  const recCode = enable.data.recoveryCodes[0];
  const verifyRec = await req('POST', '/auth/2fa/verify', { challenge: login2.data.challenge, recoveryCode: recCode });
  assert.strictEqual(verifyRec.status, 200);
  assert.ok(verifyRec.data.token);

  // Réutilisation du même code de secours -> 401
  const reuseRec = await req('POST', '/auth/2fa/verify', { challenge: login2.data.challenge, recoveryCode: recCode });
  assert.strictEqual(reuseRec.status, 401);

  // Désactivation avec un autre code de secours
  const disable = await req('POST', '/auth/2fa/disable', {
    password: 'alicepass2',
    code: enable.data.recoveryCodes[1],
  }, verifyRec.data.token);
  assert.strictEqual(disable.status, 200);
  assert.strictEqual((await req('GET', '/auth/2fa/status', null, verifyRec.data.token)).data.enabled, false);
});

test('journal d\'activité : trace les mutations sans secrets, filtrable et paginé', async () => {
  const patch = await req('PATCH', `/servers/${srv1}`, { max_players: 16 }, adminToken);
  assert.strictEqual(patch.status, 200);

  const act = await req('GET', `/activity?server=${srv1}&limit=20&page=1`, null, adminToken);
  assert.strictEqual(act.status, 200);
  assert.ok(act.data.total >= 1);
  assert.ok(act.data.items.some(e => e.username === 'admin' && e.action.startsWith('PATCH /api/servers/') && e.status === 200));

  // Vérifie qu'aucun secret/mot de passe n'a fui dans details
  const allAct = await req('GET', '/activity?limit=100', null, adminToken);
  const dumped = JSON.stringify(allAct.data.items);
  assert.ok(!dumped.includes('alicepass1'));
  assert.ok(!dumped.includes('alicepass2'));
  assert.ok(!dumped.includes('password123'));

  // Filtre utilisateur + pagination
  const byUser = await req('GET', '/activity?user=alice&limit=2&page=1', null, adminToken);
  assert.strictEqual(byUser.status, 200);
  assert.ok(byUser.data.items.length <= 2);
  assert.ok(byUser.data.items.every(e => e.username === 'alice'));
});

test('anti brute-force : /api/auth/2fa/verify renvoie 429 après 10 échecs', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const r = await req('POST', '/auth/2fa/verify', { challenge: 'invalid', code: '000000' });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(401) && statuses.at(-1) === 429, statuses.join(','));
});

test('websocket logs:subscribe : refuse un utilisateur sans permission view', async () => {
  // On arrête le backend fils avant d'ouvrir la base en-process pour vérifier la logique Socket.io
  proc?.kill();
  db?.close();
  proc = null;
  db = null;

  process.env.DATA_PATH = DATA;
  const { initDb } = require(src('config/database'));
  await initDb();
  const { setupLogsSocket } = require(src('websocket/logs'));

  let onConnect;
  const mockIo = { on(ev, fn) { if (ev === 'connection') onConnect = fn; }, to() { return { emit() {} }; }, emit() {} };
  setupLogsSocket(mockIo);

  const handlers = {};
  const emitted = [];
  const joined = [];
  const fakeSocket = {
    user: { id: userId, username: 'alice', role: 'user' },
    rooms: new Set(),
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, payload) { emitted.push([ev, payload]); },
    join(room) { joined.push(room); fakeSocket.rooms.add(room); },
    leave(room) { fakeSocket.rooms.delete(room); },
  };
  onConnect(fakeSocket);

  // srv2 : alice n'a aucune permission -> doit recevoir logs:error et ne pas rejoindre la room
  await handlers['logs:subscribe']({ serverId: srv2 });
  assert.strictEqual(joined.length, 0);
  assert.ok(emitted.some(([ev, payload]) => ev === 'logs:error' && payload.serverId === srv2));
});
