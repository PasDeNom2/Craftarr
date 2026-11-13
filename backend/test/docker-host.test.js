const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { src } = require('./helpers');

const dockerModulePath = require.resolve(src('services/docker'));
const origHost = process.env.DOCKER_HOST;
const origSocket = process.env.DOCKER_SOCKET;

function restoreEnv() {
  if (origHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = origHost;
  if (origSocket === undefined) delete process.env.DOCKER_SOCKET;
  else process.env.DOCKER_SOCKET = origSocket;
  delete require.cache[dockerModulePath];
}

function loadFreshDocker() {
  delete require.cache[dockerModulePath];
  return require(dockerModulePath);
}

afterEach(restoreEnv);

test('dockerOptions retourne un client TCP quand DOCKER_HOST commence par tcp://', () => {
  process.env.DOCKER_HOST = 'tcp://docker-proxy:2375';
  delete process.env.DOCKER_SOCKET;

  const mod = loadFreshDocker();
  assert.deepStrictEqual(mod._internals.dockerOptions(), {
    host: 'docker-proxy',
    port: 2375,
    protocol: 'http',
  });
  assert.strictEqual(mod.docker.modem.host, 'docker-proxy');
  assert.strictEqual(Number(mod.docker.modem.port), 2375);
  assert.ok(!mod.docker.modem.socketPath);
});

test('dockerOptions gère un port personnalisé ou absent dans DOCKER_HOST', () => {
  const { _internals } = loadFreshDocker();

  process.env.DOCKER_HOST = 'tcp://127.0.0.1:2376';
  assert.deepStrictEqual(_internals.dockerOptions(), {
    host: '127.0.0.1',
    port: 2376,
    protocol: 'http',
  });

  process.env.DOCKER_HOST = 'tcp://docker-proxy';
  assert.deepStrictEqual(_internals.dockerOptions(), {
    host: 'docker-proxy',
    port: 2375,
    protocol: 'http',
  });
});

test('dockerOptions utilise socketPath par défaut ou DOCKER_SOCKET sinon', () => {
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_SOCKET;

  let mod = loadFreshDocker();
  assert.deepStrictEqual(mod._internals.dockerOptions(), {
    socketPath: '/var/run/docker.sock',
  });
  assert.strictEqual(mod.docker.modem.socketPath, '/var/run/docker.sock');

  process.env.DOCKER_SOCKET = '/run/user/1000/docker.sock';
  mod = loadFreshDocker();
  assert.deepStrictEqual(mod._internals.dockerOptions(), {
    socketPath: '/run/user/1000/docker.sock',
  });
  assert.strictEqual(mod.docker.modem.socketPath, '/run/user/1000/docker.sock');
});
