const fs = require('fs');
const os = require('os');
const path = require('path');

/** Dossier temporaire unique, supprimé à la fin du process de test. */
function tmpDir(prefix = 'craftarr-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Initialise un DATA_PATH temporaire (à appeler AVANT tout require de src/). */
function useTempDataPath() {
  const dir = tmpDir();
  process.env.DATA_PATH = dir;
  return dir;
}

const SRC = path.join(__dirname, '..', 'src');
const src = (rel) => path.join(SRC, rel);

module.exports = { tmpDir, useTempDataPath, src, SRC };
