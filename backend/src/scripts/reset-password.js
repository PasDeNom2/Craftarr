/**
 * Réinitialise le mot de passe d'un compte Craftarr.
 *
 *   docker exec -it craftarr-backend node src/scripts/reset-password.js [utilisateur] [nouveau-mot-de-passe]
 *
 * Sans utilisateur : le premier compte créé (l'admin). Sans mot de passe : un mot de passe
 * aléatoire est généré et affiché. Fonctionne pendant que le backend tourne (SQLite WAL).
 */
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

process.env.DATA_PATH = process.env.DATA_PATH || '/data';
const { initDb, getDb } = require(path.join(__dirname, '../config/database'));

async function main() {
  const [usernameArg, passwordArg] = process.argv.slice(2);
  await initDb();
  const db = getDb();

  const user = usernameArg
    ? db.prepare('SELECT id, username FROM users WHERE username = ?').get(usernameArg)
    : db.prepare('SELECT id, username FROM users ORDER BY rowid LIMIT 1').get();
  if (!user) {
    const names = db.prepare('SELECT username FROM users').all().map(u => u.username);
    console.error(usernameArg
      ? `Utilisateur "${usernameArg}" introuvable. Comptes existants : ${names.join(', ') || '(aucun)'}`
      : 'Aucun compte : ouvrez l\'interface pour créer le compte admin (jeton dans les logs du backend).');
    process.exit(1);
  }

  const password = passwordArg || crypto.randomBytes(9).toString('base64url');
  if (password.length < 8) {
    console.error('Mot de passe trop court (min 8 caractères).');
    process.exit(1);
  }

  // token_version + 1 : les sessions ouvertes avec l'ancien mot de passe sont déconnectées
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await bcrypt.hash(password, 10), user.id);
  console.log(`Mot de passe de "${user.username}" réinitialisé (sessions ouvertes déconnectées).`);
  if (!passwordArg) console.log(`Nouveau mot de passe : ${password}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
