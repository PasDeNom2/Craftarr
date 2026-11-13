// Socle d'extensions : bus d'événements isolant les erreurs, registre vide par défaut.
const { test } = require('node:test');
const assert = require('node:assert');
const { src } = require('./helpers');

test('events : un abonné qui plante ne bloque ni l\'émetteur ni les autres abonnés', async () => {
  const events = require(src('services/events'));
  const seen = [];
  const off1 = events.on('test:x', () => { throw new Error('boum'); });
  const off2 = events.on('test:x', async () => { throw new Error('boum async'); });
  const off3 = events.on('test:x', p => seen.push(p.serverId));
  assert.doesNotThrow(() => events.emit('test:x', { serverId: 'a' }));
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(seen, ['a']);
  off1(); off2(); off3();
  events.emit('test:x', { serverId: 'b' });
  assert.deepStrictEqual(seen, ['a']);
});

test('extensions : valeurs neutres sans extension (port de jeu publié, aucun env ni champ)', () => {
  const ext = require(src('services/extensions'));
  const server = { id: 's1', port: 25565 };
  assert.ok(Array.isArray(ext.env(server, {})));
  assert.strictEqual(ext.publishGamePort(server), true);
  const p = ext.ports(server, {});
  assert.ok(p.exposed && p.bindings);
  assert.strictEqual(typeof ext.fields(), 'object');
  assert.strictEqual(typeof ext.decorate({}), 'object');
});
