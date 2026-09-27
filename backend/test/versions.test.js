const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const { isMcVersion, mcVersionFromNeoForge, requiredJava } = require(src('services/mcVersion'));
const { _internals: docker } = require(src('services/docker'));

test('isMcVersion : schémas 1.x et annuel 26.x, rejette les versions de loader', () => {
  for (const v of ['1.12.2', '1.21.1', '1.21.11', '26.1', '26.1.2']) assert.ok(isMcVersion(v), v);
  for (const v of ['47.2.0', '21.1.226', 'NeoForge', null, '']) assert.ok(!isMcVersion(v), String(v));
});

test('mcVersionFromNeoForge', () => {
  assert.strictEqual(mcVersionFromNeoForge('26.1.2.97'), '26.1.2');
  assert.strictEqual(mcVersionFromNeoForge('26.2.0.88'), '26.2');
  assert.strictEqual(mcVersionFromNeoForge('21.1.226'), '1.21.1');
  assert.strictEqual(mcVersionFromNeoForge('20.4.237'), '1.20.4');
  assert.strictEqual(mcVersionFromNeoForge(null), null);
});

test('requiredJava / image itzg', () => {
  assert.strictEqual(requiredJava('1.12.2'), 8);
  assert.strictEqual(requiredJava('1.18.2'), 17);
  assert.strictEqual(requiredJava('1.20.6'), 21);
  assert.strictEqual(requiredJava('26.1.2'), 25);
  assert.strictEqual(requiredJava(null, '26.1.2.97'), 25);
  assert.strictEqual(docker.resolveMinecraftImage(null, '26.1.2.97'), 'itzg/minecraft-server:java25');
});

function serverDir(id) {
  const d = path.join(DATA, 'servers', id, 'server');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const envOf = (server) => docker.buildEnvVars({ ram_mb: 4096, rcon_password: 'x', max_players: 10, ...server })
  .filter(e => /^(TYPE|VERSION|NEOFORGE_VERSION|FORGE_VERSION|FABRIC_LOADER_VERSION|MODPACK|USE_AIKAR_FLAGS|STOP_DURATION)=/.test(e));

test('env : NeoForge installé par ServerStarter → version du pack, même si un autre NeoForge traîne', () => {
  const d = serverDir('nf1');
  for (const v of ['26.1.2.97', '26.2.0.88']) {
    const lib = path.join(d, 'libraries/net/neoforged/neoforge', v);
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'unix_args.txt'), '');
  }
  fs.writeFileSync(path.join(d, 'server-setup-config.yaml.done'), 'install:\n  mcVersion:\n  loaderVersion: 26.1.2.97\n');
  const env = envOf({ id: 'nf1', loader_type: 'neoforge', mc_version: null });
  assert.ok(env.includes('NEOFORGE_VERSION=26.1.2.97') && env.includes('VERSION=26.1.2'), env.join(' '));
});

test('env : loader épinglé par .craftarr-pack.json, pas de MODPACK pour un .mrpack', () => {
  const d = serverDir('fab1');
  fs.writeFileSync(path.join(d, '.craftarr-pack.json'), JSON.stringify({ mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' }));
  const env = envOf({ id: 'fab1', loader_type: 'fabric', mc_version: '1.21', modpack_download_url: 'https://cdn.modrinth.com/p.mrpack' });
  assert.ok(env.includes('VERSION=1.21.1') && env.includes('FABRIC_LOADER_VERSION=0.16.5'), env.join(' '));
  assert.ok(!env.some(e => e.startsWith('MODPACK=')));
  assert.ok(env.includes('USE_AIKAR_FLAGS=true') && env.includes('STOP_DURATION=110'));
});

test('Simple Voice Chat : port UDP = port du serveur, autres réglages conservés', () => {
  const d = serverDir('vc1');
  const server = { id: 'vc1', port: 25570 };
  const file = path.join(d, 'config/voicechat/voicechat-server.properties');
  docker.ensureVoiceChatPort(server);
  assert.ok(!fs.existsSync(file), 'rien sans le mod');
  fs.mkdirSync(path.join(d, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(d, 'mods/voicechat-neoforge-2.6.22.jar'), '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# conf\nport=24454\nmax_voice_distance=48.0\n');
  docker.ensureVoiceChatPort(server);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '# conf\nport=25570\nmax_voice_distance=48.0\n');
});
