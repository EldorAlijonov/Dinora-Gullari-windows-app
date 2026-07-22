import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { LocalDatabaseService } from '../local-db/local-database.service';
import { UsersService } from '../modules/users/users.service';

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^([^#=\s]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

async function seed() {
  loadEnvFile();
  process.env.LOCAL_DATABASE_ENABLED = 'true';

  const database = new LocalDatabaseService();
  await database.open();
  const users = new UsersService(database);

  const email = process.env.ADMIN_EMAIL || 'admin@dinora.uz';
  const phone = process.env.ADMIN_PHONE || '+998901234567';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const username = process.env.ADMIN_USERNAME || 'admin';

  await users.upsertAdmin({
    fullName: 'Dinora Admin',
    email,
    phone,
    password,
    username,
  });

  database.persist();
  database.onModuleDestroy();
  console.log(`Demo admin ready: ${username} / ${password}`);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
