const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { src } = require('./helpers');
const { parseNbt, serializeNbt, toSnbt, parseSnbt, T } = require(src('services/nbt'));

// Arbre couvrant tous les types de tags
const tree = {
  type: T.COMPOUND,
  value: [
    ['Data', { type: T.COMPOUND, value: [
      ['LevelName', { type: T.STRING, value: 'Mon "monde" é\n' }],
      ['hardcore', { type: T.BYTE, value: 1 }],
      ['SpawnY', { type: T.SHORT, value: -64 }],
      ['GameType', { type: T.INT, value: 2147483647 }],
      ['RandomSeed', { type: T.LONG, value: -9223372036854775808n }],
      ['BorderSize', { type: T.FLOAT, value: Math.fround(0.1) }],
      ['BorderCenterX', { type: T.DOUBLE, value: 1234.5678901234 }],
      ['Whole', { type: T.DOUBLE, value: 3 }],
      ['bytes', { type: T.BYTE_ARRAY, value: [1, -2, 127] }],
      ['ints', { type: T.INT_ARRAY, value: Array.from({ length: 40 }, (_, i) => i * 1000 - 7) }],
      ['longs', { type: T.LONG_ARRAY, value: [1n, -5n] }],
      ['emptyList', { type: T.LIST, value: { elType: T.END, items: [] } }],
      ['names', { type: T.LIST, value: { elType: T.STRING, items: ['a', 'b c'] } }],
      ['players', { type: T.LIST, value: { elType: T.COMPOUND, items: [[['x', { type: T.INT, value: 1 }]], []] } }],
      ['weird key!', { type: T.INT, value: 5 }],
    ] }],
  ],
};

test('NBT gzip → SNBT → NBT : identique octet pour octet', () => {
  for (const compression of ['gzip', 'zlib', 'none']) {
    const bin = serializeNbt({ name: '', root: tree, compression });
    const parsed = parseNbt(bin);
    assert.strictEqual(parsed.compression, compression);
    const snbt = toSnbt(parsed.root);
    const back = serializeNbt({ name: '', root: parseSnbt(snbt), compression: 'none' });
    const orig = compression === 'gzip' ? zlib.gunzipSync(bin) : compression === 'zlib' ? zlib.inflateSync(bin) : bin;
    assert.ok(back.equals(orig), `${compression} : binaire différent`);
  }
});

test('SNBT lisible et typé', () => {
  const snbt = toSnbt(tree);
  assert.match(snbt, /hardcore: 1b/);
  assert.match(snbt, /SpawnY: -64s/);
  assert.match(snbt, /RandomSeed: -9223372036854775808L/);
  assert.match(snbt, /BorderSize: 0\.1f/);
  assert.match(snbt, /Whole: 3\.0d/);
  assert.match(snbt, /bytes: \[B; 1b, -2b, 127b\]/);
  assert.match(snbt, /longs: \[L; 1L, -5L\]/);
  assert.match(snbt, /"weird key!": 5/);
  assert.match(snbt, /LevelName: "Mon \\"monde\\" é\\n"/);
});

test('modifications utilisateur : types conservés, erreurs claires', () => {
  const edited = toSnbt(tree).replace('hardcore: 1b', 'hardcore: 0b').replace('GameType: 2147483647', 'GameType: 1');
  const bin = serializeNbt({ name: '', root: parseSnbt(edited), compression: 'gzip' });
  const data = parseNbt(bin).root.value[0][1].value;
  assert.deepStrictEqual(data.find(([k]) => k === 'hardcore')[1], { type: T.BYTE, value: 0 });
  assert.deepStrictEqual(data.find(([k]) => k === 'GameType')[1], { type: T.INT, value: 1 });

  assert.throws(() => parseSnbt('{a: 1b, a: 2b}'), /en double/);
  assert.throws(() => parseSnbt('{a: 300b}'), /plage d'un byte/);
  assert.throws(() => parseSnbt('{a: [1, "x"]}'), /même type/);
  assert.throws(() => parseSnbt('{a: 1\nb: 2}'), /ligne 2/);
  assert.deepStrictEqual(parseSnbt('{ok: true, // commentaire\n n: 1.5, t: [1b,2b,],}').value.map(([k, v]) => [k, v.type]),
    [['ok', T.BYTE], ['n', T.DOUBLE], ['t', T.LIST]]);
});

test('fichiers non NBT refusés', () => {
  assert.throws(() => parseNbt(Buffer.from([0xe2, 0x98, 0x83])), /NBT/); // session.lock (☃)
  assert.throws(() => parseNbt(Buffer.from('hello')), /NBT|tronqué/);
});
