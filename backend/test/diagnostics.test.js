const { test } = require('node:test');
const assert = require('node:assert');
const { src } = require('./helpers');

const { diagnoseLine, createDiagnoser } = require(src('services/logDiagnostics'));
const { parseTps, tpsCommandFor } = require(src('services/rcon'));

test('diagnostics : erreurs connues reconnues', () => {
  assert.match(diagnoseLine('java.lang.UnsupportedClassVersionError: x (class file version 69.0), this version only recognizes up to 65.0'), /Java 25/);
  assert.match(diagnoseLine('java.lang.OutOfMemoryError: Java heap space'), /Mémoire insuffisante/);
  assert.match(diagnoseLine('**** FAILED TO BIND TO PORT!'), /Port déjà utilisé/);
  assert.match(diagnoseLine('Missing or unsupported mandatory dependencies:'), /Mod manquant/);
});

test('diagnostics : pas de faux positif sur des logs normaux', () => {
  for (const line of [
    '[Server thread/INFO]: Done (27.193s)! For help, type "help"',
    '[main/WARN] [mixin/]: Error loading class: net/minecraft/client/Options (java.lang.ClassNotFoundException)',
    '[Server thread/WARN]: Can\'t keep up! Is the server overloaded? Running 2037ms or 40 ticks behind',
  ]) assert.strictEqual(diagnoseLine(line), null, line);
});

test('diagnostics : un conseil par période (crash-loop)', () => {
  const d = createDiagnoser();
  const line = 'java.lang.OutOfMemoryError: Java heap space';
  assert.ok(d(line));
  assert.strictEqual(d(line), null);
});

test('TPS : commande et parsing selon le loader', () => {
  assert.strictEqual(tpsCommandFor({ loader_type: 'neoforge' }), 'neoforge tps');
  assert.strictEqual(tpsCommandFor({ loader_type: 'fabric' }), 'tick query');
  assert.strictEqual(tpsCommandFor({ loader_type: 'paper' }), 'tps');
  assert.deepStrictEqual(parseTps('Overworld: 20.000 TPS (17.4 ms/tick)\nOverall: 20.000 TPS (18.838 ms/tick)'), { tps1: 20, tps5: null, tps15: null });
  assert.deepStrictEqual(parseTps('§6TPS from last 1m, 5m, 15m: §a*20.0, §a19.98, §a19.95'), { tps1: 20, tps5: 19.98, tps15: 19.95 });
  assert.deepStrictEqual(parseTps('Overall: Mean tick time: 3.2 ms. Mean TPS: 20.000'), { tps1: 20, tps5: null, tps15: null });
  assert.strictEqual(parseTps('Average time per tick: 62.5ms (Target: 50.0ms)').tps1, 16);
  assert.strictEqual(parseTps('Unknown or incomplete command'), null);
});

test('Mixin : erreur fatale diagnostiquée, simple WARN ignoré', () => {
  assert.match(diagnoseLine('Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinApplyError: Mixin [x.json:Foo] failed'), /Conflit/);
  assert.strictEqual(diagnoseLine('[22:19:29] [main/WARN]: Mixin apply for mod necronomicon failed necronomicon-common.mixins.json:item.X'), null);
});

test('Fabric : « recommends … which is missing » ignoré, « requires » diagnostiqué', () => {
  assert.strictEqual(diagnoseLine(" - Mod 'Debugify' (debugify) 1.20.1+2.0 recommends any version of modmenu, which is missing!"), null);
  assert.match(diagnoseLine(" - Mod 'Create' (create) 6.0 requires any version of flywheel, which is missing!"), /requis/);
  assert.match(diagnoseLine('net.fabricmc.loader.impl.FormattedException: Incompatible mods found!'), /requis/);
});

test('Mixin : trace d\'un avertissement ignorée, cause d\'un crash diagnostiquée', () => {
  assert.strictEqual(diagnoseLine('org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on getName'), null);
  assert.match(diagnoseLine('Caused by: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure'), /Conflit/);
});
