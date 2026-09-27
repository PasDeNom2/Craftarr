// Intégration : lance le vrai backend (src/index.js) sur un DATA_PATH temporaire, sans Docker.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const { tmpDir, src } = require('./helpers');

const DATA = tmpDir();
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const env = { ...process.env, DATA_PATH: DATA, PORT: String(PORT), NODE_ENV: 'test' };
delete env.JWT_SECRET;

let proc, out = '', jwt, db;
const id = 'bbbbbbbb-0000-0000-0000-000000000000';
const serverDir = path.join(DATA, 'servers', id, 'server');
const backupsDir = path.join(DATA, 'backups', id);

async function waitFor(re, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = out.match(re); if (m) return m; await new Promise(r => setTimeout(r, 100)); }
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
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
async function upload(buf) {
  const fd = new FormData();
  fd.append('world', new Blob([buf]), 'w.zip');
  const res = await fetch(`${BASE}/servers/${id}/world-import`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  return res.status;
}
const level = () => fs.readFileSync(path.join(serverDir, 'monde', 'level.dat'), 'utf8');

before(async () => { await startBackend(); });
after(() => { proc?.kill(); db?.close(); });

test('premier démarrage : jeton obligatoire, à usage unique', async () => {
  const token = (await waitFor(/Jeton de configuration : ([0-9A-F]{12})/))[1];
  assert.ok(!/Mot de passe :/.test(out));
  assert.strictEqual((await req('POST', '/auth/setup', { username: 'admin', password: 'motdepasse1' })).status, 403);
  assert.strictEqual((await req('POST', '/auth/setup', { username: 'admin', password: 'motdepasse1', setupToken: 'AAAAAAAAAAAA' })).status, 403);
  const ok = await req('POST', '/auth/setup', { username: 'admin', password: 'motdepasse1', setupToken: token.toLowerCase() });
  assert.strictEqual(ok.status, 200);
  jwt = ok.data.token;
  assert.strictEqual((await req('POST', '/auth/setup', { username: 'x2', password: 'motdepasse2', setupToken: token })).status, 403);
});

test('sécurité : CORS fermé, token forgé rejeté', async () => {
  const h = await fetch(BASE + '/health', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(h.headers.get('access-control-allow-origin'), null);
  assert.strictEqual((await req('GET', '/auth/me', null, 'forged.token.value')).status, 401);
  assert.strictEqual((await req('GET', '/auth/me', null, jwt)).status, 200);
});

test('sécurité : connexion bloquée après 10 échecs', async () => {
  assert.strictEqual((await req('POST', '/auth/login', { username: 'admin', password: 'motdepasse1' })).status, 200);
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await req('POST', '/auth/login', { username: 'admin', password: 'faux' })).status);
  assert.ok(codes.includes(401) && codes.at(-1) === 429, codes.join(','));
});

test('backup : rangé dans data/backups/<id>, basé sur level-name', async () => {
  db = new Database(path.join(DATA, 'craftarr.db'));
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'Test', '1', 'T', 'curseforge', 25599, 25609, 'x', 2048, 5, 'stopped', 'neoforge')`).run(id);
  fs.mkdirSync(path.join(serverDir, 'monde'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=monde\n');
  fs.writeFileSync(path.join(serverDir, 'monde', 'level.dat'), 'OLD');
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mods', 'a.jar'), 'jar');

  assert.strictEqual((await req('POST', `/servers/${id}/backup`, null, jwt)).status, 200);
  const zips = fs.readdirSync(backupsDir);
  assert.strictEqual(zips.length, 1);
  const names = new AdmZip(path.join(backupsDir, zips[0])).getEntries().map(e => e.entryName);
  assert.ok(names.includes('monde/level.dat') && !names.some(n => n.startsWith('mods/')), names.join(','));
});

test('ports : création et modification refusées sur un port déjà utilisé', async () => {
  const create = await req('POST', '/servers', { name: 'Doublon', modpack_id: '1', modpack_source: 'curseforge', port: 25599 }, jwt);
  assert.strictEqual(create.status, 409);
  assert.match(create.data.error, /25599.*Test/);

  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES ('eeeeeeee-0000-0000-0000-000000000000', 'Autre', '1', 'A', 'curseforge', 25620, 25630, 'x', 2048, 5, 'stopped', 'fabric')`).run();
  assert.strictEqual((await req('PATCH', '/servers/eeeeeeee-0000-0000-0000-000000000000', { port: 25599 }, jwt)).status, 409);
  assert.strictEqual((await req('PATCH', '/servers/eeeeeeee-0000-0000-0000-000000000000', { port: 25640 }, jwt)).status, 200);
  db.prepare("DELETE FROM servers WHERE id = 'eeeeeeee-0000-0000-0000-000000000000'").run();
});

test('import de monde : refus des zips invalides, bascule sûre sinon', async () => {
  assert.strictEqual(await upload(Buffer.from('pas un zip')), 400);
  const noWorld = new AdmZip(); noWorld.addFile('readme.txt', Buffer.from('x'));
  assert.strictEqual(await upload(noWorld.toBuffer()), 400);
  assert.strictEqual(level(), 'OLD');

  const good = new AdmZip();
  good.addFile('MyWorld/level.dat', Buffer.from('NEW'));
  good.addFile('MyWorld/region/r.0.0.mca', Buffer.from('chunk'));
  good.addFile('MyWorld_nether/DIM-1/x', Buffer.from('nether'));
  assert.strictEqual(await upload(good.toBuffer()), 200);
  assert.strictEqual(level(), 'NEW');
  assert.ok(fs.existsSync(path.join(serverDir, 'monde_nether', 'DIM-1', 'x')));
  assert.ok(fs.existsSync(path.join(serverDir, 'mods', 'a.jar')));
  assert.strictEqual(fs.readdirSync(backupsDir).filter(f => f.includes('pre-import')).length, 1);
});

test('restauration : backup corrompu refusé, backup valide restauré', async () => {
  const corrupt = path.join(backupsDir, 'corrupt.zip');
  fs.writeFileSync(corrupt, 'garbage');
  db.prepare("INSERT INTO backups (id, server_id, filename, path, size_bytes, trigger) VALUES ('bad', ?, 'corrupt.zip', ?, 7, 'manual')").run(id, corrupt);
  assert.strictEqual((await req('POST', `/servers/${id}/backups/bad/restore`, null, jwt)).status, 400);
  assert.strictEqual(level(), 'NEW');

  const first = db.prepare("SELECT id FROM backups WHERE server_id = ? AND trigger = 'manual' AND id != 'bad'").get(id).id;
  assert.strictEqual((await req('POST', `/servers/${id}/backups/${first}/restore`, null, jwt)).status, 200);
  assert.strictEqual(level(), 'OLD');
  assert.ok(!fs.existsSync(path.join(serverDir, 'monde_nether')));
});

test('téléchargement de monde : lien signé, usage unique, zip streamé', async () => {
  assert.strictEqual((await fetch(`${BASE}/servers/${id}/world-download`)).status, 401);
  const { data } = await req('POST', `/servers/${id}/world-download-token`, null, jwt);
  const other = data.url.replace(id, 'dddddddd-0000-0000-0000-000000000000');
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}${other}`)).status, 401);
  const dl = await fetch(`http://127.0.0.1:${PORT}${data.url}`);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers.get('content-length'), null);
  const names = new AdmZip(Buffer.from(await dl.arrayBuffer())).getEntries().map(e => e.entryName);
  assert.ok(names.includes('monde/level.dat'), names.join(','));
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}${data.url}`)).status, 401);
});

test('suppression : dossier effacé, backups et autres dossiers conservés', async () => {
  const other = path.join(DATA, 'servers', 'dossier-inconnu');
  fs.mkdirSync(other, { recursive: true });
  const del = await req('DELETE', `/servers/${id}`, null, jwt);
  assert.strictEqual(del.status, 200);
  assert.ok(!fs.existsSync(path.join(DATA, 'servers', id)));
  assert.strictEqual(del.data.backupsKeptIn, backupsDir);
  assert.ok(fs.existsSync(other));
});

test('reset-password.js puis redémarrage', async () => {
  execFileSync(process.execPath, [src('scripts/reset-password.js'), 'admin', 'nouveau-mdp-42'], { env });
  proc.kill();
  await new Promise(r => proc.once('exit', r));
  await startBackend();
  assert.ok(!/Jeton de configuration/.test(out), 'pas de jeton quand un compte existe');
  assert.match(out, /Backups planifiés toutes les 6 h/);
  assert.strictEqual((await req('POST', '/auth/login', { username: 'admin', password: 'nouveau-mdp-42' })).status, 200);
});
