const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const AdmZip = require('adm-zip');
const { src } = require('./helpers');

const { readZipJson } = require(src('services/remoteZip'));

// Zip de test : un manifest + un gros fichier incompressible (on vérifie qu'il n'est pas téléchargé)
const zip = new AdmZip();
zip.addFile('manifest.json', Buffer.from(JSON.stringify({ files: [{ projectID: 1, fileID: 2 }] })));
zip.addFile('overrides/big.bin', require('crypto').randomBytes(512 * 1024));
const ZIP = zip.toBuffer();

let base;
let servedBytes = 0;
const srv = http.createServer((req, res) => {
  // Comme forgecdn : l'URL publique redirige, et seule l'URL finale accepte les Range
  if (req.url === '/public/pack.zip') {
    if (req.headers.range) { res.writeHead(404); return res.end(); }
    res.writeHead(302, { Location: '/cdn/pack.zip' }); return res.end();
  }
  if (req.url !== '/cdn/pack.zip') { res.writeHead(404); return res.end(); }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-length': ZIP.length, 'accept-ranges': 'bytes' }); return res.end();
  }
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (!m) { servedBytes += ZIP.length; res.writeHead(200, { 'content-length': ZIP.length }); return res.end(ZIP); }
  const chunk = ZIP.subarray(+m[1], +m[2] + 1);
  servedBytes += chunk.length;
  res.writeHead(206, { 'content-length': chunk.length, 'content-range': `bytes ${m[1]}-${m[2]}/${ZIP.length}` });
  res.end(chunk);
});
before(() => new Promise(r => srv.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${srv.address().port}`; r(); })));
after(() => srv.close());

test('readZipJson : suit la redirection et ne lit que les octets utiles', async () => {
  servedBytes = 0;
  const manifest = await readZipJson(`${base}/public/pack.zip`, 'manifest.json');
  assert.deepStrictEqual(manifest, { files: [{ projectID: 1, fileID: 2 }] });
  assert.ok(servedBytes < ZIP.length / 4, `trop d'octets téléchargés : ${servedBytes} / ${ZIP.length}`);
});

test('readZipJson : entrée absente → null', async () => {
  assert.strictEqual(await readZipJson(`${base}/cdn/pack.zip`, 'modrinth.index.json'), null);
});
