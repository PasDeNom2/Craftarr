const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const { _internals: t } = require(src('services/installer'));

const JAR = Buffer.from('fake jar content '.repeat(100));
const sha1 = crypto.createHash('sha1').update(JAR).digest('hex');
const sha512 = crypto.createHash('sha512').update(JAR).digest('hex');
const hits = {};
let base;
const srv = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/ok.jar') { res.writeHead(200, { 'content-length': JAR.length }); return res.end(JAR); }
  if (req.url === '/truncated.jar') { res.writeHead(200, { 'content-length': JAR.length + 50 }); res.write(JAR); return res.destroy(); }
  if (req.url === '/flaky.jar' && hits[req.url] === 1) { res.writeHead(500); return res.end(); }
  if (req.url === '/flaky.jar') { res.writeHead(200, { 'content-length': JAR.length }); return res.end(JAR); }
  res.writeHead(404); res.end();
});
before(() => new Promise(r => srv.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${srv.address().port}`; r(); })));
after(() => srv.close());

const dl = (name) => path.join(DATA, name);

test('downloadFile : succès + sha1', async () => {
  await t.downloadFile(`${base}/ok.jar`, dl('a.jar'), null, { sha1 });
  assert.ok(fs.readFileSync(dl('a.jar')).equals(JAR));
});

test('downloadFile : hash invalide → rejet sans fichier laissé', async () => {
  await assert.rejects(t.downloadFile(`${base}/ok.jar`, dl('b.jar'), null, { sha1: 'deadbeef' }), /hash sha1 invalide/);
  assert.ok(!fs.existsSync(dl('b.jar')) && !fs.existsSync(dl('b.jar.part')));
});

test('downloadFile : 404 sans nouvelle tentative', async () => {
  await assert.rejects(t.downloadFile(`${base}/missing.jar`, dl('c.jar')));
  assert.strictEqual(hits['/missing.jar'], 1);
});

test('downloadFile : téléchargement tronqué rejeté', async () => {
  await assert.rejects(t.downloadFile(`${base}/truncated.jar`, dl('d.jar')));
  assert.ok(!fs.existsSync(dl('d.jar')));
});

test('downloadFile : erreur transitoire → nouvelle tentative réussie', async () => {
  await t.downloadFile(`${base}/flaky.jar`, dl('e.jar'), null, { sha512 });
  assert.strictEqual(hits['/flaky.jar'], 2);
});

test('safeJoin bloque le zip-slip', () => {
  assert.throws(() => t.safeJoin(DATA, '../evil.txt'), /refusé/);
  assert.throws(() => t.safeJoin(DATA, 'config/../../evil.txt'), /refusé/);
  assert.ok(t.safeJoin(DATA, 'config/a.toml').startsWith(path.resolve(DATA)));
});

/** Construit un .mrpack ; "XXXXXX" dans un nom d'entrée devient "../../" (vraie archive piégée). */
function mrpack(files, extra = []) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' }, files })));
  zip.addFile('overrides/config/a.toml', Buffer.from('client'));
  zip.addFile('server-overrides/config/a.toml', Buffer.from('server'));
  for (const [n, c] of extra) zip.addFile(n, Buffer.from(c));
  const p = path.join(DATA, `pack-${crypto.randomUUID()}.mrpack`);
  fs.writeFileSync(p, Buffer.from(zip.toBuffer().toString('latin1').split('XXXXXX').join('../../'), 'latin1'));
  return p;
}
const newServerDir = () => { const d = path.join(DATA, `srv-${crypto.randomUUID()}`); fs.mkdirSync(d); return d; };

test('installMrpack : loader épinglé, server:unsupported exclu, URL de secours, server-overrides prioritaire', async () => {
  const d = newServerDir();
  const meta = await t.installMrpack({ id: 'test-server-0000' }, mrpack([
    { path: 'mods/server.jar', downloads: [`${base}/missing.jar`, `${base}/ok.jar`], hashes: { sha1, sha512 }, env: { client: 'required', server: 'required' } },
    { path: 'mods/optional.jar', downloads: [`${base}/ok.jar`], hashes: { sha1 }, env: { client: 'optional', server: 'optional' } },
    { path: 'mods/shaders.jar', downloads: [`${base}/ok.jar`], env: { client: 'optional', server: 'unsupported' } },
  ]), d, null);
  assert.deepStrictEqual(meta, { mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' });
  assert.ok(fs.existsSync(path.join(d, 'mods/server.jar')) && fs.existsSync(path.join(d, 'mods/optional.jar')));
  assert.ok(!fs.existsSync(path.join(d, 'mods/shaders.jar')));
  assert.strictEqual(fs.readFileSync(path.join(d, 'config/a.toml'), 'utf8'), 'server');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, '.craftarr-pack.json'))), meta);
});

test('installMrpack : archive piégée (zip-slip) refusée', async () => {
  await assert.rejects(t.installMrpack({ id: 'test-server-0000' }, mrpack([], [['overrides/XXXXXXevil.txt', 'x']]), newServerDir(), null), /refusé/);
});

test('installMrpack : mod introuvable → échec explicite', async () => {
  await assert.rejects(
    t.installMrpack({ id: 'test-server-0000' }, mrpack([{ path: 'mods/missing.jar', downloads: [`${base}/missing.jar`], env: { server: 'required' } }]), newServerDir(), null),
    /n'ont pas pu être téléchargés : mods\/missing\.jar/,
  );
});

test('ramAdvice', () => {
  const md = newServerDir();
  for (let i = 0; i < 233; i++) fs.writeFileSync(path.join(md, `m${i}.jar`), '');
  assert.match(t.ramAdvice(md, 6144), /233 mods pour 6 Go de RAM : 8 Go recommandés/);
  assert.strictEqual(t.ramAdvice(md, 8192), null);
});
