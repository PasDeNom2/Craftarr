const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { tmpDir, src } = require('./helpers');

const zipStream = require(src('services/zipStream'));

test('zipStream : extraction normale (fichiers, sous-dossiers, listEntries et permissions)', async () => {
  const root = tmpDir();
  const zipPath = path.join(root, 'normal.zip');
  const dest = path.join(root, 'dest');

  const zip = new AdmZip();
  zip.addFile('level.dat', Buffer.from('WORLD-DATA'));
  zip.addFile('region/r.0.0.mca', Buffer.from([1, 2, 3, 4]));
  zip.addFile('sub/empty/', Buffer.alloc(0));
  // SUID/SGID positionnés dans le zip : ne doivent pas être conservés à l'extraction
  zip.getEntry('level.dat').attr = (0o104755 << 16) >>> 0;
  zip.writeZip(zipPath);

  const entries = await zipStream.listEntries(zipPath);
  assert.deepStrictEqual(entries, ['level.dat', 'region/r.0.0.mca', 'sub/empty/']);

  await zipStream.extractAll(zipPath, dest);

  assert.strictEqual(fs.readFileSync(path.join(dest, 'level.dat'), 'utf8'), 'WORLD-DATA');
  assert.deepStrictEqual(fs.readFileSync(path.join(dest, 'region', 'r.0.0.mca')), Buffer.from([1, 2, 3, 4]));
  assert.ok(fs.statSync(path.join(dest, 'sub', 'empty')).isDirectory());

  const fileMode = fs.statSync(path.join(dest, 'level.dat')).mode & 0o7777;
  assert.strictEqual(fileMode & 0o6000, 0); // pas de SUID/SGID
  assert.strictEqual(fileMode & 0o111, 0);  // pas d'exécution
});

test('zipStream : rejette traversée ../evil.txt et n’écrit rien hors destination', async () => {
  const root = tmpDir();
  const zipPath = path.join(root, 'traversal.zip');
  const dest = path.join(root, 'nested', 'dest');
  fs.mkdirSync(dest, { recursive: true });

  // adm-zip ≥ 0.6.1 retire « .. » à la création : on écrit « xx/evil.txt » puis on remplace
  // le nom par « ../evil.txt » (même longueur) dans l'en-tête local et le répertoire central.
  const zip = new AdmZip();
  zip.addFile('xx/evil.txt', Buffer.from('evil'));
  const buf = zip.toBuffer();
  const from = Buffer.from('xx/evil.txt');
  const to = Buffer.from('../evil.txt');
  let i = buf.indexOf(from), n = 0;
  while (i !== -1) { to.copy(buf, i); n++; i = buf.indexOf(from, i + 1); }
  assert.strictEqual(n, 2);
  fs.writeFileSync(zipPath, buf);

  await assert.rejects(() => zipStream.extractAll(zipPath, dest));
  assert.strictEqual(fs.existsSync(path.join(root, 'nested', 'evil.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'evil.txt')), false);
});

test('zipStream : rejette un dépassement de maxTotalBytes en octets réellement écrits', async () => {
  const root = tmpDir();
  const zipPath = path.join(root, 'limit.zip');
  const dest = path.join(root, 'dest');

  const zip = new AdmZip();
  zip.addFile('big.bin', Buffer.alloc(5000, 0x41));
  zip.writeZip(zipPath);

  await assert.rejects(
    () => zipStream.extractAll(zipPath, dest, { maxTotalBytes: 1000 }),
    /Taille maximale/
  );
});

test('zipStream : rejette une entrée lien symbolique', async () => {
  const root = tmpDir();
  const zipPath = path.join(root, 'symlink.zip');
  const dest = path.join(root, 'dest');

  const zip = new AdmZip();
  zip.addFile('link', Buffer.from('/etc/passwd'));
  zip.getEntry('link').attr = (0o120777 << 16) >>> 0;
  zip.writeZip(zipPath);

  await assert.rejects(
    () => zipStream.extractAll(zipPath, dest),
    /Lien symbolique/
  );
  assert.strictEqual(fs.existsSync(path.join(dest, 'link')), false);
});
