// Vérifie que chaque require() relatif du backend pointe vers un fichier existant — y compris ceux
// placés dans le corps des fonctions, qui ne cassent qu'à l'exécution de la route concernée.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SRC } = require('./helpers');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('tous les require() relatifs se résolvent', () => {
  const broken = [];
  for (const file of jsFiles(SRC)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      try { require.resolve(path.resolve(path.dirname(file), m[1])); } catch { broken.push(`${path.relative(SRC, file)} → ${m[1]}`); }
    }
  }
  assert.deepStrictEqual(broken, []);
});
