const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, tmpDir, src } = require('./helpers');

const DATA = useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const filesRouter = require(src('routes/servers/files'));
const { resolveSafe } = filesRouter;

const id = 'ffffffff-3333-0000-0000-000000000000';
let server, base, token, serverRoot, outsideDir;

before(() => {
  initDb();
  const db = getDb();
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'F', '1', 'F', 'curseforge', 25573, 25583, 'x', 4096, 20, 'running', 'neoforge')`).run(id);
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });

  serverRoot = path.join(DATA, 'servers', id, 'server');
  fs.mkdirSync(path.join(serverRoot, 'sub'), { recursive: true });
  outsideDir = tmpDir('craftarr-outside-');
  fs.symlinkSync(outsideDir, path.join(serverRoot, 'link'));

  // Mini app Express avec authentification réelle
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/servers', filesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/servers/${id}`;
});

after(() => server?.close());

const putJson = (p, body) => fetch(base + p, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

test('resolveSafe : bloque les chemins via un dossier lien symbolique sortant', () => {
  const root = path.join(tmpDir('craftarr-root-'), 'root');
  const outside = tmpDir('craftarr-out-');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'existing.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'));
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'in-link'));

  assert.throws(() => resolveSafe(root, 'link/new.txt'), err => err.status === 403);
  assert.throws(() => resolveSafe(root, 'link/a/b/c.txt'), err => err.status === 403);
  assert.throws(() => resolveSafe(root, 'file-link.txt'), err => err.status === 403);
  assert.throws(() => resolveSafe(root, '../outside.txt'), err => err.status === 403);

  assert.strictEqual(resolveSafe(root, 'existing.txt'), path.join(root, 'existing.txt'));
  assert.strictEqual(resolveSafe(root, 'sub/new.txt'), path.join(root, 'sub', 'new.txt'));
  assert.strictEqual(resolveSafe(root, 'nouveau/dossier/x.txt'), path.join(root, 'nouveau', 'dossier', 'x.txt'));
  assert.strictEqual(resolveSafe(root, 'in-link/new.txt'), path.join(root, 'in-link', 'new.txt'));
});

test('PUT /files/content : refuse 403 via un dossier lien symbolique et n’écrit pas dehors', async () => {
  const res1 = await putJson('/files/content', { path: 'link/new.txt', content: 'pwned' });
  assert.strictEqual(res1.status, 403);
  assert.strictEqual(fs.existsSync(path.join(outsideDir, 'new.txt')), false);

  const res2 = await putJson('/files/content', { path: 'link/a/b/c.txt', content: 'pwned' });
  assert.strictEqual(res2.status, 403);
  assert.strictEqual(fs.existsSync(path.join(outsideDir, 'a')), false);
});

test('PUT /files/content et PUT /files/nbt : refusent 403 si la cible est un lien symbolique', async () => {
  const realTxt = path.join(serverRoot, 'sub', 'real.txt');
  fs.writeFileSync(realTxt, 'original');
  fs.symlinkSync(realTxt, path.join(serverRoot, 'sym.txt'));

  const resTxt = await putJson('/files/content', { path: 'sym.txt', content: 'modifié' });
  assert.strictEqual(resTxt.status, 403);
  assert.strictEqual(fs.readFileSync(realTxt, 'utf8'), 'original');

  const realDat = path.join(serverRoot, 'sub', 'real.dat');
  fs.writeFileSync(realDat, 'dummy');
  fs.symlinkSync(realDat, path.join(serverRoot, 'sym.dat'));

  const resNbt = await putJson('/files/nbt', { path: 'sym.dat', content: '{}' });
  assert.strictEqual(resNbt.status, 403);
});

test('PUT /files/content : autorise l’écriture dans un sous-dossier normal', async () => {
  const res = await putJson('/files/content', { path: 'sub/ok.txt', content: 'bonjour' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(serverRoot, 'sub', 'ok.txt'), 'utf8'), 'bonjour');
});
