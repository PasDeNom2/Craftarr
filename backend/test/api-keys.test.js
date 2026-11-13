// Tests d'intégration C2 : création, authentification, révocation, droits, throttling et WebSocket des clés API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftarr-apikeys-test-'));
process.env.DATA_PATH = dataDir;

const app = require('../src/index');
const { getDb } = require('../src/config/database');
const { signUserToken, hashApiKey } = require('../src/config/secrets');

let baseUrl = '';
let db;
let adminUser;
let adminToken;
let aliceUser;
let aliceToken;

async function api(p, { method = 'GET', token, apiKey, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (apiKey) h['X-API-Key'] = apiKey;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

async function socketHandshake({ authToken, headers = {} } = {}) {
  const r1 = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, { headers });
  assert.equal(r1.status, 200);
  const openText = await r1.text();
  assert.ok(openText.startsWith('0'), `Paquet Engine.IO inattendu : ${openText}`);
  const { sid } = JSON.parse(openText.slice(1));

  const body = authToken !== undefined ? `40${JSON.stringify({ token: authToken })}` : '40';
  const r2 = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' },
    body,
  });
  assert.equal(r2.status, 200);

  const r3 = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, { headers });
  assert.equal(r3.status, 200);
  const pollText = await r3.text();
  return pollText.split('\x1e');
}

describe('API Keys (C2)', () => {
  before(async () => {
    await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        const addr = app.server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    db = getDb();
    const adminId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, disabled, token_version)
      VALUES (?, ?, ?, 'admin', 0, 0)
    `).run(adminId, 'admin', 'not-used-in-direct-token');
    adminUser = { id: adminId, username: 'admin', role: 'admin', token_version: 0 };
    adminToken = signUserToken(adminUser);

    const created = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'alice', password: 'AlicePassword123!', role: 'user' },
    });
    assert.equal(created.status, 201);
    aliceUser = created.json;

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'AlicePassword123!' },
    });
    assert.equal(login.status, 200);
    aliceToken = login.json.token;

    db.prepare(`
      INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, rcon_password, mc_version, port, ram_mb, status)
      VALUES (?, ?, 'vanilla', 'Vanilla', 'vanilla', 'rcon-test', '1.21', 25565, 2048, 'stopped')
    `).run('srv-test-1', 'TestSrv');

    const grant = await api(`/api/users/${aliceUser.id}/servers/srv-test-1`, {
      method: 'PUT',
      token: adminToken,
      body: { perms: ['view'] },
    });
    assert.equal(grant.status, 200);
  });

  after(async () => {
    try {
      app.get('io')?.close();
    } catch {}
    try {
      app.server?.closeAllConnections?.();
    } catch {}
    await new Promise((resolve) => app.server.close(() => resolve()));
    try {
      db?.close();
    } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('crée une clé au format cra_<40 base62> et ne stocke que son hash SHA-256', async () => {
    const res = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'CI Pipeline', read_only: false, expires_in_days: 30 },
    });
    assert.equal(res.status, 201);
    assert.match(res.json.key, /^cra_[0-9A-Za-z]{40}$/);
    assert.equal(res.json.prefix, res.json.key.slice(4, 12));
    assert.equal(res.json.read_only, false);
    assert.ok(res.json.expires_at);

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(res.json.id);
    assert.ok(row);
    assert.equal(row.hash, hashApiKey(res.json.key));
    assert.equal(JSON.stringify(row).includes(res.json.key), false);

    const list = await api('/api/api-keys', { token: adminToken });
    assert.equal(list.status, 200);
    const listed = list.json.find((k) => k.id === res.json.id);
    assert.ok(listed);
    assert.equal(listed.key, undefined);
    assert.equal(listed.hash, undefined);
  });

  it('authentifie via X-API-Key et Authorization: Bearer cra_…', async () => {
    const created = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Header Auth Key' },
    });
    assert.equal(created.status, 201);
    const key = created.json.key;

    const r1 = await api('/api/servers', { apiKey: key });
    assert.equal(r1.status, 200);

    const r2 = await api('/api/servers', { token: key });
    assert.equal(r2.status, 200);

    const me = await api('/api/auth/me', { apiKey: key });
    assert.equal(me.status, 200);
    assert.equal(me.json.username, 'admin');
    assert.equal(me.json.role, 'admin');
  });

  it('autorise GET/HEAD et refuse POST/PUT/PATCH/DELETE pour une clé read_only', async () => {
    const created = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Monitoring RO', read_only: true },
    });
    assert.equal(created.status, 201);
    const roKey = created.json.key;

    assert.equal((await api('/api/servers', { apiKey: roKey })).status, 200);
    assert.equal((await api('/api/servers', { method: 'HEAD', apiKey: roKey })).status, 200);

    assert.equal((await api('/api/users', {
      method: 'POST',
      apiKey: roKey,
      body: { username: 'nobody', password: 'Password123!' },
    })).status, 403);
    assert.equal((await api('/api/settings', {
      method: 'PUT',
      apiKey: roKey,
      body: {},
    })).status, 403);
    assert.equal((await api(`/api/users/${aliceUser.id}`, {
      method: 'PATCH',
      apiKey: roKey,
      body: { disabled: false },
    })).status, 403);
    assert.equal((await api(`/api/users/${aliceUser.id}`, {
      method: 'DELETE',
      apiKey: roKey,
    })).status, 403);
  });

  it('interdit toute clé API sur la gestion des clés, le mot de passe et la 2FA (403)', async () => {
    const created = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Admin Full Key', read_only: false },
    });
    assert.equal(created.status, 201);
    const rwKey = created.json.key;

    const blocked = [
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys', { name: 'Nested' }],
      ['DELETE', `/api/api-keys/${created.json.id}`],
      ['POST', '/api/auth/password', { currentPassword: 'x', newPassword: 'y' }],
      ['GET', '/api/auth/2fa/status'],
      ['POST', '/api/auth/2fa/setup'],
      ['POST', '/api/auth/2fa/enable', { code: '123456' }],
      ['POST', '/api/auth/2fa/disable', { code: '123456' }],
    ];

    for (const [method, endpoint, body] of blocked) {
      const res = await api(endpoint, { method, apiKey: rwKey, body });
      assert.equal(res.status, 403, `${method} ${endpoint} devrait renvoyer 403, reçu ${res.status}`);
    }
  });

  it('rejette les clés invalides, révoquées, expirées ou d\'un utilisateur désactivé (401)', async () => {
    const unknown = await api('/api/servers', { apiKey: `cra_${'a'.repeat(40)}` });
    assert.equal(unknown.status, 401);

    const kRevoke = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'To Revoke' },
    });
    assert.equal(kRevoke.status, 201);
    assert.equal((await api('/api/servers', { apiKey: kRevoke.json.key })).status, 200);

    const del = await api(`/api/api-keys/${kRevoke.json.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(del.status, 200);
    assert.equal((await api('/api/servers', { apiKey: kRevoke.json.key })).status, 401);

    const kExp = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'To Expire', expires_in_days: 1 },
    });
    assert.equal(kExp.status, 201);
    db.prepare("UPDATE api_keys SET expires_at = datetime('now', '-5 minutes') WHERE id = ?").run(kExp.json.id);
    assert.equal((await api('/api/servers', { apiKey: kExp.json.key })).status, 401);

    const kAlice = await api('/api/api-keys', {
      method: 'POST',
      token: aliceToken,
      body: { name: 'Alice Key' },
    });
    assert.equal(kAlice.status, 201);
    assert.equal((await api('/api/servers', { apiKey: kAlice.json.key })).status, 200);

    const disableRes = await api(`/api/users/${aliceUser.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { disabled: true },
    });
    assert.equal(disableRes.status, 200);
    assert.equal((await api('/api/servers', { apiKey: kAlice.json.key })).status, 401);

    const enableRes = await api(`/api/users/${aliceUser.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { disabled: false },
    });
    assert.equal(enableRes.status, 200);
    assert.equal((await api('/api/servers', { apiKey: kAlice.json.key })).status, 200);

    // La désactivation incrémente token_version : le JWT d'Alice est invalidé, on la reconnecte.
    const relogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'AlicePassword123!' },
    });
    assert.equal(relogin.status, 200);
    aliceToken = relogin.json.token;
  });

  it('hérite des permissions du compte utilisateur et isole ?all=1 et la révocation', async () => {
    const kAdmin = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Admin Owned' },
    });
    const kAlice = await api('/api/api-keys', {
      method: 'POST',
      token: aliceToken,
      body: { name: 'Alice Scoped' },
    });
    assert.equal(kAdmin.status, 201);
    assert.equal(kAlice.status, 201);

    // Alice a seulement 'view' sur srv-test-1
    const servers = await api('/api/servers', { apiKey: kAlice.json.key });
    assert.equal(servers.status, 200);
    assert.ok(servers.json.some((s) => s.id === 'srv-test-1'));

    const usersForbidden = await api('/api/users', { apiKey: kAlice.json.key });
    assert.equal(usersForbidden.status, 403);

    const filesForbidden = await api('/api/servers/srv-test-1/files', { apiKey: kAlice.json.key });
    assert.equal(filesForbidden.status, 403);

    // Alice ne peut ni voir ?all=1 ni révoquer une clé d'un autre utilisateur
    const allForbidden = await api('/api/api-keys?all=1', { token: aliceToken });
    assert.equal(allForbidden.status, 403);

    const revokeOther = await api(`/api/api-keys/${kAdmin.json.id}`, {
      method: 'DELETE',
      token: aliceToken,
    });
    assert.equal(revokeOther.status, 404);

    // Admin voit ?all=1 avec les noms d'utilisateur
    const allAdmin = await api('/api/api-keys?all=1', { token: adminToken });
    assert.equal(allAdmin.status, 200);
    assert.ok(allAdmin.json.some((k) => k.id === kAlice.json.id && k.username === 'alice'));
    assert.ok(allAdmin.json.some((k) => k.id === kAdmin.json.id && k.username === 'admin'));
  });

  it('limite la mise à jour de last_used_at à au plus une fois par minute', async () => {
    const created = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Throttle Check' },
    });
    assert.equal(created.status, 201);

    assert.equal((await api('/api/servers', { apiKey: created.json.key })).status, 200);
    const firstRow = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.json.id);
    assert.ok(firstRow.last_used_at);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await api('/api/servers', { apiKey: created.json.key })).status, 200);
    const secondRow = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.json.id);
    assert.equal(secondRow.last_used_at, firstRow.last_used_at);

    db.prepare("UPDATE api_keys SET last_used_at = datetime('now', '-2 minutes') WHERE id = ?").run(created.json.id);
    assert.equal((await api('/api/servers', { apiKey: created.json.key })).status, 200);
    const thirdRow = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.json.id);
    assert.notEqual(thirdRow.last_used_at, null);
    assert.ok(thirdRow.last_used_at >= firstRow.last_used_at);
  });

  it('applique la limite de 25 clés actives par utilisateur', async () => {
    const bob = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'boblimit', password: 'BobPassword123!', role: 'user' },
    });
    assert.equal(bob.status, 201);
    const bobLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'boblimit', password: 'BobPassword123!' },
    });
    assert.equal(bobLogin.status, 200);
    const bobToken = bobLogin.json.token;

    const createdIds = [];
    for (let i = 0; i < 25; i++) {
      const res = await api('/api/api-keys', {
        method: 'POST',
        token: bobToken,
        body: { name: `Key ${i + 1}` },
      });
      assert.equal(res.status, 201, `La clé ${i + 1} aurait dû être créée`);
      createdIds.push(res.json.id);
    }

    const overLimit = await api('/api/api-keys', {
      method: 'POST',
      token: bobToken,
      body: { name: 'Key 26' },
    });
    assert.equal(overLimit.status, 400);

    const revoked = await api(`/api/api-keys/${createdIds[0]}`, {
      method: 'DELETE',
      token: bobToken,
    });
    assert.equal(revoked.status, 200);

    const afterRevoke = await api('/api/api-keys', {
      method: 'POST',
      token: bobToken,
      body: { name: 'Replacement Key' },
    });
    assert.equal(afterRevoke.status, 201);
  });

  it('accepte une clé API valide sur Socket.io et rejette une clé révoquée ou absente', async () => {
    const valid = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Socket Valid' },
    });
    const toRevoke = await api('/api/api-keys', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Socket Revoked' },
    });
    assert.equal(valid.status, 201);
    assert.equal(toRevoke.status, 201);
    await api(`/api/api-keys/${toRevoke.json.id}`, { method: 'DELETE', token: adminToken });

    const viaAuth = await socketHandshake({ authToken: valid.json.key });
    assert.ok(viaAuth.some((p) => p.startsWith('40')), `Connexion Socket attendue (40), reçu : ${viaAuth.join('|')}`);

    const viaHeader = await socketHandshake({ headers: { 'X-API-Key': valid.json.key } });
    assert.ok(viaHeader.some((p) => p.startsWith('40')), `Connexion Socket via header attendue, reçu : ${viaHeader.join('|')}`);

    const rejectedRevoked = await socketHandshake({ authToken: toRevoke.json.key });
    assert.ok(rejectedRevoked.some((p) => p.startsWith('44')), `Rejet Socket (44) attendu, reçu : ${rejectedRevoked.join('|')}`);

    const rejectedMissing = await socketHandshake({});
    assert.ok(rejectedMissing.some((p) => p.startsWith('44')), `Rejet Socket sans token (44) attendu, reçu : ${rejectedMissing.join('|')}`);
  });
});
