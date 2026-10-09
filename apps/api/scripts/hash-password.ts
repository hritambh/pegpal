/* Usage: bun run --cwd apps/api hash-password '<password>'  → prints ADMIN_PASSWORD_HASH value */
import { hashPassword } from '../src/admin/password';

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Provide a password of at least 12 characters as the first argument.');
  process.exit(1);
}
console.log(hashPassword(password));
