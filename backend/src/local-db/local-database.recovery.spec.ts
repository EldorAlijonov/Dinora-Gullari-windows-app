import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalDatabaseError } from './database-errors';
import { LocalDatabaseService } from './local-database.service';

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'dinora-db-test-'));
}

async function openService(dataDir: string) {
  process.env.DINORA_DATA_DIR = dataDir;
  process.env.LOCAL_DATABASE_PATH = join(dataDir, 'dinora-gullari.sqlite');
  const service = new LocalDatabaseService();
  await service.open();
  return service;
}

function cleanup(dataDir: string) {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DINORA_DATA_DIR;
  delete process.env.LOCAL_DATABASE_PATH;
}

function writeOrder(service: LocalDatabaseService, id: string) {
  const now = new Date().toISOString();
  service.run(
    `INSERT INTO orders (
      id, customerName, phone, telegramPhone, orderText, totalAmount, prepaidAmount, debtAmount,
      pickupDate, status, note, isTelegramNotified, payments, createdBy, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'Test Customer', '+998900000000', '', 'Roses', 100000, 25000, 75000, now, 'new', '', 0, '[]', null, now, now],
  );
}

async function createHealthyDatabaseWithBackup(dataDir: string) {
  const service = await openService(dataDir);
  writeOrder(service, 'order-1');
  const backupPath = service.createVerifiedBackup('test');
  service.onModuleDestroy();
  return backupPath;
}

async function expectOrderCount(dataDir: string, expected: number) {
  const service = await openService(dataDir);
  const count = service.get<{ count: number }>('SELECT COUNT(*) as count FROM orders')?.count || 0;
  assert.equal(count, expected);
  service.onModuleDestroy();
}

function corruptPrimary(dataDir: string, content: Buffer) {
  writeFileSync(join(dataDir, 'dinora-gullari.sqlite'), content);
}

test('healthy database opens and preserves data', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    await expectOrderCount(dataDir, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('missing database creates first-install database', async () => {
  const dataDir = tempDataDir();
  try {
    await expectOrderCount(dataDir, 0);
  } finally {
    cleanup(dataDir);
  }
});

test('zero-byte primary database restores from healthy backup', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    corruptPrimary(dataDir, Buffer.alloc(0));
    await expectOrderCount(dataDir, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('all-zero primary database restores from healthy backup', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    corruptPrimary(dataDir, Buffer.alloc(446464, 0));
    await expectOrderCount(dataDir, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('random-bytes primary database restores from healthy backup', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    corruptPrimary(dataDir, Buffer.from('not a sqlite database'));
    await expectOrderCount(dataDir, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('latest corrupt backup is rejected and previous healthy backup is restored', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    const corruptBackup = join(dataDir, 'backups', 'dinora-backup-latest-corrupt.sqlite');
    writeFileSync(corruptBackup, Buffer.from('broken backup'));
    const future = new Date(Date.now() + 60_000);
    utimesSync(corruptBackup, future, future);
    corruptPrimary(dataDir, Buffer.from('broken primary'));
    await expectOrderCount(dataDir, 1);
  } finally {
    cleanup(dataDir);
  }
});

test('corrupt primary with no healthy backup fails without creating empty database', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
    corruptPrimary(dataDir, Buffer.from('broken primary'));
    await assert.rejects(() => openService(dataDir), (error) => {
      assert(error instanceof LocalDatabaseError);
      assert.equal(error.code, 'DATABASE_BACKUP_NOT_FOUND');
      return true;
    });
  } finally {
    cleanup(dataDir);
  }
});

test('corrupt import is rejected and existing primary remains unchanged', async () => {
  const dataDir = tempDataDir();
  try {
    await createHealthyDatabaseWithBackup(dataDir);
    const importPath = join(dataDir, 'bad-import.sqlite');
    writeFileSync(importPath, Buffer.from('bad import'));
    const service = await openService(dataDir);
    await assert.rejects(() => service.replaceDatabaseFromFile(importPath), (error) => {
      assert(error instanceof LocalDatabaseError);
      assert.equal(error.code, 'DATABASE_IMPORT_INVALID');
      return true;
    });
    const count = service.get<{ count: number }>('SELECT COUNT(*) as count FROM orders')?.count || 0;
    assert.equal(count, 1);
    service.onModuleDestroy();
  } finally {
    cleanup(dataDir);
  }
});

async function main() {
  for (const item of tests) {
    await item.run();
    console.log(`PASS ${item.name}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
