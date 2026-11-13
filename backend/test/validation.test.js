// Tests P2-C : validation des entrées, ports sans rcon_port, secrets.json corrompu,
// clé de chiffrement, masquage des erreurs 500, login temps constant et sauvegardes orphelines.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const bcrypt = require('bcrypt');
const { useTempDataPath, tmpDir, src } = require('./helpers');

const DATA = useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const { loadOrCreateSecrets, signUserToken } = require(src('config/secrets'));
const { encrypt, decrypt } = require(src('config/encryption'));
const validate = require(src('services/validate'));
const dockerService = require(src('services/docker'));
const installer = require(src('services/installer'));
const serverLock = require(src('services/serverLock'));

let db, httpServer, base, token;
const origInstallServer = installer.installServer;
const origDocker = {
  startContainer: dockerService.startContainer,
  stopContainer: dockerService.stopContainer,
  restartContainer: dockerService.restartContainer,
  createServerContainer: dockerService.createServerContainer,
  removeContainer: dockerService.removeContainer,
};

function resetStubs() {
  installer.installServer = async () => {};
  dockerService.startContainer = async () => {};
  dockerService.stopContainer = async () => {};
  dockerService.restartContainer = async () => {};
  dockerService.removeContainer = async () => {};
  dockerService.createServerContainer = async (srv) => ({
    containerId: `cid-${srv.id.slice(0, 8)}`,
    containerName: `mc-${srv.id.slice(0, 8)}`,
  });
}

async function req(method, urlPath, body, authToken = token) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  loadOrCreateSecrets();
  initDb();
  db = getDb();
  resetStubs();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require(src('routes/auth')).router);
  app.use('/api/servers', require(src('routes/servers/lifecycle')));
  const backups = require(src('routes/backups'));
  app.use('/api/servers', backups);
  app.use('/api/backups', backups.orphans);

  app.get('/api/test-error-500', (req, res, next) => {
    next(new Error('SQLITE_ERROR: détail interne sensible'));
  });
  app.get('/api/test-error-400', (req, res, next) => {
    next(Object.assign(new Error('Requête invalide explicite'), { status: 400 }));
  });
  app.use(require(src('middleware/errorHandler')));

  httpServer = app.listen(0);
  base = `http://127.0.0.1:${httpServer.address().port}/api`;

  const hash = await bcrypt.hash('bonmotdepasse', 10);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run('u-val-1', 'admin', hash);
  token = signUserToken({ id: 'u-val-1', username: 'admin', token_version: 0 });
});

after(() => {
  httpServer?.close();
  installer.installServer = origInstallServer;
  Object.assign(dockerService, origDocker);
});

test('validate.js : int, bool, str, oneOf', () => {
  assert.strictEqual(validate.int('25570', { min: 1024, max: 65535, field: 'port' }), 25570);
  assert.strictEqual(validate.int(2048, { min: 512, max: 262144, field: 'ram_mb' }), 2048);
  assert.throws(() => validate.int('abc', { min: 1, max: 10, field: 'x' }), err => err.status === 400 && /«x» doit être un entier entre 1 et 10/.test(err.message));
  assert.throws(() => validate.int(1.5, { min: 1, max: 10, field: 'x' }), err => err.status === 400);
  assert.throws(() => validate.int('', { min: 0, max: 10, field: 'x' }), err => err.status === 400);
  assert.throws(() => validate.int(80, { min: 1024, max: 65535, field: 'port' }), err => err.status === 400);

  assert.strictEqual(validate.bool(true), true);
  assert.strictEqual(validate.bool('false'), false);
  assert.strictEqual(validate.bool('1'), true);
  assert.strictEqual(validate.bool(0), false);
  assert.throws(() => validate.bool('oui'), err => err.status === 400);

  assert.strictEqual(validate.str('  Mon Serveur  ', { max: 64, field: 'name' }), 'Mon Serveur');
  assert.throws(() => validate.str('   ', { max: 64, field: 'name' }), err => err.status === 400);
  assert.strictEqual(validate.str('', { max: 64, field: 'seed', allowEmpty: true }), '');
  assert.throws(() => validate.str('a\nb', { max: 256, field: 'motd', allowEmpty: true, noNewlines: true }), err => err.status === 400);

  assert.strictEqual(validate.oneOf('hard', ['peaceful', 'easy', 'normal', 'hard'], 'difficulty'), 'hard');
  assert.throws(() => validate.oneOf('extreme', ['peaceful', 'easy', 'normal', 'hard'], 'difficulty'), err => err.status === 400);
});

test('PATCH /api/servers/:id : validation des entrées, normalisation avant comparaison, requireIdle', async () => {
  const id = 'aaaa1111-0000-0000-0000-000000000001';
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type, needs_recreate)
    VALUES (?, 'ValSrv', '1', 'V', 'curseforge', 25570, 25580, 'sec', 4096, 20, 'stopped', 'neoforge', 0)`).run(id);

  const badRam = await req('PATCH', `/servers/${id}`, { ram_mb: 'abc' });
  assert.strictEqual(badRam.status, 400);

  const badPort = await req('PATCH', `/servers/${id}`, { port: 80 });
  assert.strictEqual(badPort.status, 400);

  const badDiff = await req('PATCH', `/servers/${id}`, { difficulty: 'x' });
  assert.strictEqual(badDiff.status, 400);

  const badMotd = await req('PATCH', `/servers/${id}`, { motd: 'ligne1\nligne2' });
  assert.strictEqual(badMotd.status, 400);

  // "25570" normalisé en 25570 ne déclenche pas needs_recreate
  const samePort = await req('PATCH', `/servers/${id}`, { port: '25570' });
  assert.strictEqual(samePort.status, 200);
  assert.strictEqual(samePort.data.needs_recreate, false);
  const row = db.prepare('SELECT port, needs_recreate FROM servers WHERE id = ?').get(id);
  assert.strictEqual(row.port, 25570);
  assert.strictEqual(row.needs_recreate, 0);

  // requireIdle bloque PATCH pendant qu'un verrou est tenu
  const release = serverLock.acquire(id, 'test-patch-lock');
  try {
    const locked = await req('PATCH', `/servers/${id}`, { name: 'AutreNom' });
    assert.strictEqual(locked.status, 409);
  } finally {
    release();
  }
});

test('POST /api/servers : validation et port 25575 accepté quand un serveur utilise 25565 (plus de conflit rcon)', async () => {
  const firstId = 'aaaa2222-0000-0000-0000-000000000001';
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'Srv25565', '1', 'S', 'curseforge', 25565, 25575, 'sec', 4096, 20, 'stopped', 'fabric')`).run(firstId);

  const badPost = await req('POST', '/servers', { name: 'Bad', modpack_id: '1', modpack_source: 'curseforge', port: 80 });
  assert.strictEqual(badPost.status, 400);

  const badRamPost = await req('POST', '/servers', { name: 'BadRam', modpack_id: '1', modpack_source: 'curseforge', ram_mb: 128 });
  assert.strictEqual(badRamPost.status, 400);

  const ok = await req('POST', '/servers', { name: 'Srv25575', modpack_id: '1', modpack_source: 'curseforge', port: 25575 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.port, 25575);
});

test('secrets.js : secrets.json corrompu renommé en .corrupt-* et erreur levée sans régénérer', () => {
  const dir = tmpDir('craftarr-corrupt-secrets-');
  const secretsPath = path.join(dir, 'secrets.json');
  fs.writeFileSync(secretsPath, '{json invalide');

  const prevDataPath = process.env.DATA_PATH;
  const prevJwt = process.env.JWT_SECRET;
  const prevEnc = process.env.ENCRYPTION_KEY;
  process.env.DATA_PATH = dir;
  delete process.env.JWT_SECRET;
  delete process.env.ENCRYPTION_KEY;

  try {
    assert.throws(() => loadOrCreateSecrets(), /secrets\.json illisible/);
    const files = fs.readdirSync(dir);
    assert.ok(files.some(f => f.startsWith('secrets.json.corrupt-')), `Attendu .corrupt-*, trouvé: ${files.join(',')}`);
    assert.strictEqual(fs.existsSync(secretsPath), false);
  } finally {
    process.env.DATA_PATH = prevDataPath;
    if (prevJwt !== undefined) process.env.JWT_SECRET = prevJwt; else delete process.env.JWT_SECRET;
    if (prevEnc !== undefined) process.env.ENCRYPTION_KEY = prevEnc; else delete process.env.ENCRYPTION_KEY;
  }
});

test('encryption.js : ENCRYPTION_KEY < 32 caractères lève une Error claire', () => {
  const prevEnc = process.env.ENCRYPTION_KEY;
  try {
    process.env.ENCRYPTION_KEY = 'trop-court';
    assert.throws(() => encrypt('secret'), /ENCRYPTION_KEY/);
    assert.throws(() => decrypt('AAAA'), /ENCRYPTION_KEY/);
  } finally {
    if (prevEnc !== undefined) process.env.ENCRYPTION_KEY = prevEnc; else delete process.env.ENCRYPTION_KEY;
  }
});

test('errorHandler : masque les erreurs >= 500 sauf expose=true (Docker dans lifecycle)', async () => {
  const boom = await req('GET', '/test-error-500');
  assert.strictEqual(boom.status, 500);
  assert.strictEqual(boom.data.error, 'Erreur interne du serveur');

  const clientErr = await req('GET', '/test-error-400');
  assert.strictEqual(clientErr.status, 400);
  assert.strictEqual(clientErr.data.error, 'Requête invalide explicite');

  const id = 'aaaa3333-0000-0000-0000-000000000001';
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, container_id, container_name, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'DockerErr', '1', 'D', 'curseforge', 'cid-1', 'mc-1', 25576, 25586, 'sec', 4096, 20, 'stopped', 'fabric')`).run(id);

  dockerService.startContainer = async () => { throw new Error('Démon Docker indisponible'); };
  try {
    const startErr = await req('POST', `/servers/${id}/start`);
    assert.strictEqual(startErr.status, 500);
    assert.strictEqual(startErr.data.error, 'Démon Docker indisponible');
  } finally {
    resetStubs();
  }
});

test('auth.js : login avec utilisateur inexistant renvoie 401 proprement', async () => {
  const res = await req('POST', '/auth/login', { username: 'inconnu', password: 'nimportequoi' }, null);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.data.error, 'Identifiants invalides');
});

test('sauvegardes orphelines : listage, téléchargement signé à usage unique, suppression et 409 si serveur existant', async () => {
  const existingId = 'bbbb1111-0000-0000-0000-000000000001';
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'ExistSrv', '1', 'E', 'curseforge', 25577, 25587, 'sec', 4096, 20, 'stopped', 'fabric')`).run(existingId);

  const existingBackupDir = path.join(DATA, 'backups', existingId);
  fs.mkdirSync(existingBackupDir, { recursive: true });
  fs.writeFileSync(path.join(existingBackupDir, 'keep.zip'), 'ok');

  const orphanId = 'orphan-server-42';
  const orphanDir = path.join(DATA, 'backups', orphanId);
  fs.mkdirSync(orphanDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('world/level.dat', Buffer.from('ORPHAN-DATA'));
  const zipPath = path.join(orphanDir, 'x.zip');
  fs.writeFileSync(zipPath, zip.toBuffer());

  const list = await req('GET', '/backups/orphans');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.some(o => o.serverId === existingId), false);
  const entry = list.data.find(o => o.serverId === orphanId);
  assert.ok(entry);
  assert.strictEqual(entry.files.length, 1);
  assert.strictEqual(entry.files[0].filename, 'x.zip');
  assert.strictEqual(entry.totalBytes, fs.statSync(zipPath).size);

  // Nom de fichier invalide refusé en 400
  const badName = await req('GET', `/backups/orphans/${orphanId}/bad..zip/download-token`);
  assert.strictEqual(badName.status, 400);

  // Lien signé à usage unique
  const tok = await req('GET', `/backups/orphans/${orphanId}/x.zip/download-token`);
  assert.strictEqual(tok.status, 200);
  const origin = base.replace(/\/api$/, '');
  const dl1 = await fetch(`${origin}${tok.data.url}`);
  assert.strictEqual(dl1.status, 200);
  const dlEntries = new AdmZip(Buffer.from(await dl1.arrayBuffer())).getEntries().map(e => e.entryName);
  assert.ok(dlEntries.includes('world/level.dat'));

  const dl2 = await fetch(`${origin}${tok.data.url}`);
  assert.strictEqual(dl2.status, 401);

  // Refus 409 si le serveur existe encore ; 400 si serverId invalide
  assert.strictEqual((await req('DELETE', `/backups/orphans/${existingId}`)).status, 409);
  assert.strictEqual((await req('DELETE', '/backups/orphans/bad_id!')).status, 400);

  // Suppression réussie pour l'orphelin
  const del = await req('DELETE', `/backups/orphans/${orphanId}`);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(fs.existsSync(orphanDir), false);
});
