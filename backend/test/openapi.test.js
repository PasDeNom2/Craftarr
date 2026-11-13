// Tests OpenAPI 3.1 (C2) : accessibilité sans auth de /api/openapi.json et parité 100 % avec les routes Express.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Capture des chemins de montage Express 5 avant le chargement de src/index.js.
const express = require('express');
// Express 5 : Router() renvoie une fonction dont le prototype est l'instance ; on patche Router.prototype.
const routerProto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));
const origUse = routerProto.use;
routerProto.use = function patchedUse(...args) {
  const stackBefore = Array.isArray(this.stack) ? this.stack.length : 0;
  const ret = origUse.apply(this, args);
  const first = args[0];
  let mountPath = '';
  if (typeof first === 'string') mountPath = first;
  else if (Array.isArray(first) && typeof first[0] === 'string') mountPath = first[0];
  if (mountPath && Array.isArray(this.stack)) {
    for (let i = stackBefore; i < this.stack.length; i++) {
      this.stack[i]._mountPath = mountPath;
    }
  }
  return ret;
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function joinPaths(base, part) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanPart = String(part || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleanBase && !cleanPart) return '/';
  if (!cleanPart) return cleanBase || '/';
  return `${cleanBase}/${cleanPart}`;
}

function toOpenApiPath(expressPath) {
  const normalized = expressPath.length > 1 ? expressPath.replace(/\/+$/, '') : expressPath;
  return normalized.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collectExpressOperations(stack, prefix = '', out = new Set()) {
  if (!Array.isArray(stack)) return out;
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods || {})
        .filter((m) => layer.route.methods[m] && HTTP_METHODS.has(m.toLowerCase()));
      for (const routePath of [].concat(layer.route.path)) {
        const fullPath = toOpenApiPath(joinPaths(prefix, routePath));
        for (const method of methods) {
          out.add(`${method.toUpperCase()} ${fullPath}`);
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const nextPrefix = layer._mountPath ? joinPaths(prefix, layer._mountPath) : prefix;
      collectExpressOperations(layer.handle.stack, nextPrefix, out);
    }
  }
  return out;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child, getLogs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Le backend s'est arrêté prématurément (${child.exitCode}) :\n${getLogs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timeout en attendant /api/health :\n${getLogs()}`);
}

describe('OpenAPI 3.1.0 (C2)', () => {
  it('sert GET /api/openapi.json sans authentification avec une spec 3.1.0 valide', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftarr-openapi-test-'));
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const entry = path.resolve(__dirname, '../src/index.js');

    let logs = '';
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PORT: String(port), DATA_PATH: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { logs += d.toString(); });
    child.stderr.on('data', (d) => { logs += d.toString(); });

    try {
      await waitForHealth(baseUrl, child, () => logs);

      const res = await fetch(`${baseUrl}/api/openapi.json`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);

      const doc = await res.json();
      assert.equal(doc.openapi, '3.1.0');
      assert.ok(doc.info && doc.info.title && doc.info.version);
      assert.ok(doc.paths && Object.keys(doc.paths).length > 0);
      assert.ok(doc.components?.securitySchemes?.bearerAuth);
      assert.ok(doc.components?.securitySchemes?.apiKeyAuth);

      // Aucune fuite de secrets du serveur dans le document public
      const serialized = JSON.stringify(doc);
      assert.equal(serialized.includes('BEGIN '), false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
          }, 2000)),
        ]);
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('correspond à 100 % dans les deux sens entre les routes Express et paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftarr-openapi-routes-'));
    const prevDataPath = process.env.DATA_PATH;
    process.env.DATA_PATH = tempDir;

    try {
      const app = require('../src/index');
      const { buildOpenApiSpec } = require('../src/openapi');
      const doc = buildOpenApiSpec({ fresh: true });

      const routerStack = app.router?.stack || app._router?.stack;
      assert.ok(Array.isArray(routerStack) && routerStack.length > 0, 'Pile de routeur Express introuvable');

      const expressOps = collectExpressOperations(routerStack);
      const specOps = new Set();

      for (const [p, methodsObj] of Object.entries(doc.paths || {})) {
        assert.ok(p.startsWith('/'), `Chemin OpenAPI invalide : ${p}`);
        const pathParamsNames = [...p.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
        const pathLevelParams = Array.isArray(methodsObj.parameters) ? methodsObj.parameters : [];

        for (const [method, op] of Object.entries(methodsObj)) {
          if (!HTTP_METHODS.has(method.toLowerCase())) continue;
          const key = `${method.toUpperCase()} ${p}`;
          specOps.add(key);

          assert.ok(Array.isArray(op.tags) && op.tags.length > 0, `tags manquant sur ${key}`);
          assert.equal(typeof op.summary, 'string', `summary manquant sur ${key}`);
          assert.ok(op.summary.trim().length > 0, `summary vide sur ${key}`);
          assert.ok(Array.isArray(op.security), `security manquant sur ${key}`);
          assert.ok(op.responses && Object.keys(op.responses).length > 0, `responses manquant sur ${key}`);

          const allParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
          for (const paramName of pathParamsNames) {
            const found = allParams.find((pr) => pr.in === 'path' && pr.name === paramName && pr.required === true);
            assert.ok(found, `Paramètre de chemin {${paramName}} non documenté sur ${key}`);
          }
        }
      }

      const missingInSpec = [...expressOps].filter((op) => !specOps.has(op)).sort();
      const extraInSpec = [...specOps].filter((op) => !expressOps.has(op)).sort();

      assert.deepEqual(missingInSpec, [], `Routes Express absentes d'OpenAPI : ${missingInSpec.join(', ')}`);
      assert.deepEqual(extraInSpec, [], `Opérations OpenAPI absentes d'Express : ${extraInSpec.join(', ')}`);
    } finally {
      if (prevDataPath === undefined) delete process.env.DATA_PATH;
      else process.env.DATA_PATH = prevDataPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
