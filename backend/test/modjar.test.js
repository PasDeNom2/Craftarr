const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const modJar = require(src('services/modJar'));
const { _internals: inst } = require(src('services/installer'));

let n = 0;
const newDir = () => { const d = path.join(DATA, `d${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** Jar Forge/NeoForge minimal. deps : [{ modId, mandatory?, type?, side? }] */
function tomlJar(modId, deps = [], { neo = false, top = '', nested = [] } = {}) {
  const lines = [`modLoader="javafml"`, `loaderVersion="[47,)"`, top, `description='''`, `[[mods]] dans une description`, `'''`,
    `[[mods]]`, `modId="${modId}"`, `version="1.0"`, `description='''`, `Multi`, `ligne`, `'''`];
  for (const d of deps) {
    lines.push(`[[dependencies.${modId}]]`, `    modId="${d.modId}"`);
    if (d.type) lines.push(`    type="${d.type}"`); else lines.push(`    mandatory=${d.mandatory !== false}`);
    lines.push(`    side="${d.side || 'BOTH'}"`, `    versionRange="[1,)" # commentaire`);
  }
  const zip = new AdmZip();
  zip.addFile(neo ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml', Buffer.from(lines.join('\n')));
  for (const [name, buf] of nested) zip.addFile(`META-INF/jarjar/${name}`, buf);
  return zip.toBuffer();
}

function fabricJar(id, { depends = {}, breaks = {}, environment = '*', provides = [], jars = [] } = {}) {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    schemaVersion: 1, id, environment, depends, breaks, provides, jars: jars.map(([file]) => ({ file })),
  })));
  for (const [file, buf] of jars) zip.addFile(file, buf);
  return zip.toBuffer();
}

const write = (dir, name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };

test('readModInfo : mods.toml Forge (deps obligatoires, side CLIENT ignoré, description multi-ligne)', () => {
  const info = modJar.readModInfo(tomlJar('create', [
    { modId: 'forge' }, { modId: 'flywheel' }, { modId: 'jei', mandatory: false }, { modId: 'ponderui', side: 'CLIENT' },
  ]));
  assert.deepStrictEqual(info.ids, ['create']);
  assert.deepStrictEqual(info.requires, ['forge', 'flywheel']);
  assert.strictEqual(info.clientOnly, false);
});

test('readModInfo : neoforge.mods.toml (type required/incompatible), clientSideOnly, jarjar', () => {
  const lib = tomlJar('kotlinforforge', [], { neo: true });
  const info = modJar.readModInfo(tomlJar('mymod', [
    { modId: 'neoforge', type: 'required' }, { modId: 'optifine', type: 'incompatible' }, { modId: 'jei', type: 'optional' },
  ], { neo: true, top: 'clientSideOnly=true', nested: [['kff.jar', lib]] }));
  assert.strictEqual(info.loader, 'neoforge');
  assert.deepStrictEqual(info.ids, ['mymod', 'kotlinforforge']);
  assert.deepStrictEqual(info.requires, ['neoforge']);
  assert.deepStrictEqual(info.breaks, [{ id: 'optifine', range: '[1,)', kind: 'maven' }]);
  assert.strictEqual(info.clientOnly, true);
});

test('readModInfo : fabric.mod.json (provides, jars imbriqués, environment client)', () => {
  const api = fabricJar('fabric-api', { provides: ['fabric'], jars: [['META-INF/jars/base.jar', fabricJar('fabric-api-base')]] });
  const info = modJar.readModInfo(api);
  assert.deepStrictEqual(info.ids.sort(), ['fabric', 'fabric-api', 'fabric-api-base']);
  assert.strictEqual(modJar.readModInfo(fabricJar('sodium', { environment: 'client' })).clientOnly, true);
  assert.strictEqual(modJar.readModInfo(Buffer.from('pas un zip')), null);
});

test('analyze : dépendance manquante, doublon, incompatibilité déclarée', () => {
  const d = newDir();
  const files = [
    write(d, 'create-1.jar', tomlJar('create', [{ modId: 'flywheel' }, { modId: 'minecraft' }])),
    write(d, 'jei-1.jar', tomlJar('jei')),
    write(d, 'jei-2.jar', tomlJar('jei')),
    write(d, 'a.jar', fabricJar('a', { breaks: { b: '*' }, depends: { fabricloader: '*', 'fabric-api-base': '*' } })),
    write(d, 'b.jar', fabricJar('b')),
    write(d, 'api.jar', fabricJar('fabric-api', { jars: [['META-INF/jars/base.jar', fabricJar('fabric-api-base')]] })),
  ];
  const r = modJar.analyze(files);
  assert.deepStrictEqual(r.missing.map(m => m.dep), ['flywheel']);
  assert.deepStrictEqual(r.duplicates, [{ id: 'jei', files: ['jei-1.jar', 'jei-2.jar'] }]);
  assert.deepStrictEqual(r.conflicts.map(c => [c.file, c.otherFile]), [['a.jar', 'b.jar']]);
  assert.strictEqual(modJar.describeProblems(r).length, 3);
});

test('restoreRequiredClientMods : réintègre un mod client-only requis (et ses propres dépendances)', () => {
  const mods = newDir();
  const hold = newDir();
  write(mods, 'server-mod.jar', tomlJar('servermod', [{ modId: 'clothconfig' }]));
  write(hold, 'cloth.jar', tomlJar('clothconfig', [{ modId: 'architectury' }]));
  write(hold, 'arch.jar', tomlJar('architectury'));
  write(hold, 'shaders.jar', tomlJar('oculus'));
  const restored = inst.restoreRequiredClientMods(mods, hold);
  assert.deepStrictEqual(restored.sort(), ['arch.jar', 'cloth.jar']);
  assert.ok(fs.existsSync(path.join(mods, 'cloth.jar')) && fs.existsSync(path.join(mods, 'arch.jar')));
  assert.ok(fs.existsSync(path.join(hold, 'shaders.jar')));
});

test('clientOnlyReason : forceIncludes > server-setup-config > liste > tag CurseForge', () => {
  const rules = { excludes: new Set(['oculus', 'appleskin']), forceIncludes: new Set(['appleskin']) };
  const ignored = new Set(['42']);
  const r = (file, slug) => inst.clientOnlyReason({ gameVersions: [], ...file }, slug, rules, ignored);
  assert.strictEqual(r({}, 'appleskin'), null);
  assert.match(r({ modId: 42 }, 'x'), /server-setup-config/);
  assert.match(r({}, 'oculus'), /liste/);
  assert.match(r({ gameVersions: ['1.20.1', 'Forge', 'Client'] }, 'x'), /tag/);
  assert.strictEqual(r({ gameVersions: ['Client', 'Server'] }, 'x'), null);
});

test('manifestMeta : loader principal + version MC', () => {
  assert.deepStrictEqual(inst.manifestMeta({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] } }),
    { mcVersion: '1.20.1', loader: 'forge', loaderVersion: '47.2.0' });
  assert.deepStrictEqual(inst.manifestMeta(null), { mcVersion: null, loader: null, loaderVersion: null });
});

test('hoistNestedServerPack : remonte un server pack rangé dans un sous-dossier', () => {
  const d = newDir();
  fs.mkdirSync(path.join(d, 'MyPack-Server-1.2', 'mods'), { recursive: true });
  fs.mkdirSync(path.join(d, 'MyPack-Server-1.2', 'config'), { recursive: true });
  fs.writeFileSync(path.join(d, 'MyPack-Server-1.2', 'mods', 'a.jar'), 'x');
  fs.writeFileSync(path.join(d, 'MyPack-Server-1.2', 'config', 'c.toml'), 'x');
  inst.hoistNestedServerPack(d);
  assert.ok(fs.existsSync(path.join(d, 'mods', 'a.jar')) && fs.existsSync(path.join(d, 'config', 'c.toml')));
  assert.ok(!fs.existsSync(path.join(d, 'MyPack-Server-1.2')));

  // Thin pack ATM (ServerFiles-x sans mods) : intact
  const t = newDir();
  fs.mkdirSync(path.join(t, 'ServerFiles-1.0'));
  fs.writeFileSync(path.join(t, 'ServerFiles-1.0', 'startserver.sh'), '');
  inst.hoistNestedServerPack(t);
  assert.ok(fs.existsSync(path.join(t, 'ServerFiles-1.0', 'startserver.sh')));
});

test('cleanForReinstall : garde le monde et les fichiers joueurs, retire mods/loader', () => {
  const d = newDir();
  for (const p of ['world/level.dat', 'mods/old.jar', 'libraries/x.jar', 'ops.json', 'server.properties', 'config/a.toml']) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), 'x');
  }
  inst.cleanForReinstall(d);
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['ops.json', 'server.properties', 'world']);
});

test('versionRange : Fabric (>=, <, ~, ^, x, tableau) et Maven', () => {
  const { satisfiesFabric: f, satisfiesMaven: m, compare } = require(src('services/versionRange'));
  assert.ok(f('1.0.5', '<1.1.2') && !f('1.1.3', '<1.1.2'));
  assert.ok(f('0.5.3', ['<0.5.0', '~0.5.0']) && !f('0.6.0', ['<0.5.0', '~0.5.0']));
  assert.ok(f('1.2.9', '1.2.x') && !f('1.3.0', '1.2.x'));
  assert.ok(f('2.4.0', '>=2 <3') && !f('3.0.0', '>=2 <3'));
  assert.ok(f('1.0.0', '*'));
  assert.ok(!f('1.0.0', 'charabia{}'), 'plage illisible → jamais « satisfaite »');
  assert.ok(m('1.5', '[1.0,2.0)') && !m('2.0', '[1.0,2.0)') && m('3.1', '[3,)') && !m('0.9', '[1,)'));
  assert.strictEqual(compare('1.0.0-beta', '1.0.0'), -1);
  assert.strictEqual(compare('0.92.6+1.20.1', '0.92.6'), 0);
});

test('incompatibilité : seulement si la version installée est dans la plage', () => {
  const d = newDir();
  const files = [
    write(d, 'a.jar', fabricJar('a', { breaks: { emi: '<1.0.0' } })),
    write(d, 'emi.jar', (() => { const z = new AdmZip(); z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'emi', version: '1.1.24' }))); return z.toBuffer(); })()),
  ];
  assert.deepStrictEqual(modJar.analyze(files).conflicts, []);
});

test('JSON tolérant (commentaires, retours à la ligne, virgules finales) et jar multi-loader', () => {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from('\uFEFF{ // commentaire\n "schemaVersion": 1, "id": "multi", "name": "Multi\nLigne", "version": "2.0", }'));
  zip.addFile('META-INF/mods.toml', Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="multi"\nversion="2.0"\n'));
  const buf = zip.toBuffer();
  const fab = modJar.readModInfo(buf, { prefer: 'fabric' });
  assert.strictEqual(fab.loader, 'fabric');
  assert.deepStrictEqual(fab.loaders.sort(), ['fabric', 'forge']);
  assert.strictEqual(modJar.readModInfo(buf, { prefer: 'forge' }).loader, 'forge');
});

test('localZip : lit une entrée sans charger tout le zip', () => {
  const { openZip } = require(src('services/localZip'));
  const d = newDir();
  const p = write(d, 'z.jar', fabricJar('zz'));
  const z = openZip(p);
  try {
    assert.ok(z.names.includes('fabric.mod.json'));
    assert.strictEqual(JSON.parse(z.read('fabric.mod.json').toString()).id, 'zz');
    assert.strictEqual(z.read('absent.txt'), null);
  } finally { z.close(); }
  assert.throws(() => openZip(write(d, 'pas-un-zip.jar', Buffer.from('nope'))));
});

test('modManager : liste, désactivation, corbeille (rien n\'est effacé), mauvais loader signalé', () => {
  const mm = require(src('services/modManager'));
  const server = { id: 'mm-test', mc_version: '1.20.1', loader_type: 'fabric' };
  const { mods, trash } = mm.dirsOf(server.id);
  fs.mkdirSync(mods, { recursive: true });
  write(mods, 'api.jar', fabricJar('fabric-api', { provides: ['fabric'] }));
  write(mods, 'forgeonly.jar', tomlJar('forgeonly'));
  let list = mm.listMods(server);
  assert.strictEqual(list.mods.length, 2);
  assert.ok(list.problems.some(p => /forgeonly\.jar est un mod forge/.test(p)));
  assert.strictEqual(mm.setEnabled(server, 'forgeonly.jar', false), 'forgeonly.jar.disabled');
  list = mm.listMods(server);
  assert.strictEqual(list.problems.length, 0);
  assert.strictEqual(list.mods.find(m => m.file === 'forgeonly.jar.disabled').enabled, false);
  assert.deepStrictEqual(mm.trashMods(server, ['forgeonly.jar.disabled']), ['forgeonly.jar.disabled']);
  assert.ok(fs.existsSync(path.join(trash, 'forgeonly.jar.disabled')));
  assert.throws(() => mm.setEnabled(server, '../evil.jar', true), e => e.status === 400);
  assert.throws(() => mm.trashMods(server, ['../../x.jar']), e => e.status === 400);
});
