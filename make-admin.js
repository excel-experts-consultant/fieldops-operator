/**
 * Builds the wrangler command that creates a superadmin login for the
 * operator console.
 *
 *   node make-admin.js "Full Name" username password
 *
 * The password is hashed here exactly the way the API hashes it
 * (PBKDF2-SHA256, 100000 iterations, 16-byte salt), so nothing in plain text
 * ever reaches the database.
 */
const crypto = require('crypto');

const [name, usernameRaw, password] = process.argv.slice(2);

if (!name || !usernameRaw || !password) {
  console.error('Usage: node make-admin.js "Full Name" username password');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password needs at least 6 characters.');
  process.exit(1);
}

const username = usernameRaw.trim().toLowerCase();
if (!/^[a-z0-9._-]{3,}$/.test(username)) {
  console.error('Username needs 3+ characters: letters, numbers, dot, dash or underscore.');
  process.exit(1);
}

const saltHex = crypto.randomBytes(16).toString('hex');
const digest = crypto
  .pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), 100000, 32, 'sha256')
  .toString('hex');
const hash = `pbkdf2$100000$${saltHex}$${digest}`;

const sql =
  `INSERT INTO users (username, password_hash, role, name) ` +
  `VALUES ('${username}', '${hash}', 'admin', '${name.replace(/'/g, "''")}')`;

console.log('');
console.log(`  Name      ${name}`);
console.log(`  Username  ${username}`);
console.log(`  Password  ${password}`);
console.log(`  Role      superadmin`);
console.log('');
console.log('Run this:');
console.log('');
console.log(`npx wrangler d1 execute fieldops-operator --remote --command="${sql}"`);
console.log('');
