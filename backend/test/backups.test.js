const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
process.env.BACKUP_KEEP = '2';
const { initDb, getDb } = require(src('config/database'));
let db, backup;
const id = 'cccccccc-0000-0000-0000-000000000000';

before(() => {
  initDb();
  db = getDb();
  backup = require(src('services/backup'));
  // Serveur "en marche" sans container réel : le save-all RCON échoue, le backup se fait quand même
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type, container_id)
    VALUES (?, 'P2', '1', 'P2', 'curseforge', 25570, 25580, 'x', 4096, 5, 'running', 'neoforge', 'fake-ctr')`).run(id);
  const dir = path.join(DATA, 'servers', id, 'server', 'world');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), 'W');
});

const count = (trigger) => db.prepare('SELECT COUNT(*) n FROM backups WHERE server_id = ? AND trigger = ?').get(id, trigger).n;

test('backups planifiés : rétention par type, backups manuels jamais supprimés', async () => {
  await backup.createBackup(db.prepare('SELECT * FROM servers WHERE id = ?').get(id), 'manual');
  for (let i = 0; i < 4; i++) {
    await backup.runScheduledBackups();
    await new Promise(r => setTimeout(r, 1100)); // created_at à la seconde près
  }
  assert.strictEqual(count('scheduled'), 2);
  assert.strictEqual(count('manual'), 1);
  assert.strictEqual(fs.readdirSync(path.join(DATA, 'backups', id)).length, 3);
});

test('backups planifiés : serveur arrêté ignoré', async () => {
  db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(id);
  const before = count('scheduled');
  await backup.runScheduledBackups();
  assert.strictEqual(count('scheduled'), before);
});
