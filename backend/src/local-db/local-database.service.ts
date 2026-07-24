import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import initSqlJs, { BindParams, Database, SqlJsStatic } from 'sql.js';
import { getLocalDataDir, getLocalDatabasePath } from '../local-app/paths';

type SqlParam = string | number | boolean | null | Uint8Array;
type SqlParams = SqlParam[] | BindParams;

@Injectable()
export class LocalDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalDatabaseService.name);
  private sql?: SqlJsStatic;
  private db?: Database;
  private databasePath = getLocalDatabasePath();
  readonly paths = {
    data: getLocalDataDir(),
    database: this.databasePath,
    backups: join(getLocalDataDir(), 'backups'),
  };

  async onModuleInit() {
    await this.open();
  }

  onModuleDestroy() {
    this.persist();
    this.db?.close();
  }

  async open() {
    if (this.db) return;

    const wasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
    this.sql = await initSqlJs({
      locateFile: (file) => join(wasmDir, file),
    });

    mkdirSync(dirname(this.databasePath), { recursive: true });
    const existing = existsSync(this.databasePath) ? readFileSync(this.databasePath) : undefined;
    this.db = existing ? new this.sql.Database(existing) : new this.sql.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    await this.migrate();
    await this.ensureServiceAccount();
    this.persist();
    this.logger.log(`Local SQLite database ready: ${this.databasePath}`);
  }

  async replaceDatabaseFromFile(sourcePath: string) {
    const current = this.database();
    current.close();
    this.db = undefined;
    copyFileSync(sourcePath, this.databasePath);
    await this.open();
  }

  sizeInBytes() {
    try {
      return statSync(this.databasePath).size;
    } catch {
      return 0;
    }
  }

  run(sql: string, params: SqlParams = []) {
    this.database().run(sql, params);
    this.persist();
  }

  get<T extends Record<string, unknown>>(sql: string, params: SqlParams = []): T | null {
    const statement = this.database().prepare(sql);
    try {
      statement.bind(params);
      return statement.step() ? (statement.getAsObject() as T) : null;
    } finally {
      statement.free();
    }
  }

  all<T extends Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    const statement = this.database().prepare(sql);
    const rows: T[] = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  transaction<T>(work: () => T): T {
    const db = this.database();
    db.run('BEGIN IMMEDIATE;');
    try {
      const result = work();
      db.run('COMMIT;');
      this.persist();
      return result;
    } catch (error) {
      db.run('ROLLBACK;');
      throw error;
    }
  }

  createId() {
    return randomUUID();
  }

  exportCollections() {
    const collections = [
      'orders',
      'sales',
      'users',
      'notifications',
      'telegram_users',
      'settings',
      'deleted_records',
    ];
    const exported: Record<string, Record<string, unknown>[]> = {};

    for (const collection of collections) {
      const rows = this.all(`SELECT * FROM ${collection} ORDER BY createdAt DESC`);
      exported[collection] = rows.map((row) => this.deserializeRow(collection, row));
    }

    exported.appsettings = exported.settings || [];
    return exported;
  }

  persist() {
    if (!this.db) return;
    writeFileSync(this.databasePath, Buffer.from(this.db.export()));
  }

  private database() {
    if (!this.db) throw new Error('Local database has not been opened');
    return this.db;
  }

  private deserializeRow(collection: string, row: Record<string, unknown>) {
    const jsonFieldsByCollection: Record<string, string[]> = {
      orders: ['payments'],
      sales: ['payments'],
      settings: ['telegramAdminIds'],
      deleted_records: ['record'],
    };
    const jsonFields = jsonFieldsByCollection[collection] || [];
    const deserialized = { ...row };

    for (const field of jsonFields) {
      if (typeof deserialized[field] !== 'string') continue;
      try {
        deserialized[field] = JSON.parse(deserialized[field] as string);
      } catch {
        deserialized[field] = field === 'record' ? {} : [];
      }
    }

    return deserialized;
  }

  private async migrate() {
    this.database().run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        fullName TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        avatarUrl TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY DEFAULT 'global',
        storeName TEXT NOT NULL DEFAULT 'Dinora Gullari',
        storePhone TEXT NOT NULL DEFAULT '',
        storeAddress TEXT NOT NULL DEFAULT '',
        workHours TEXT NOT NULL DEFAULT '',
        logoUrl TEXT NOT NULL DEFAULT '',
        telegramOrderAcceptedEnabled INTEGER NOT NULL DEFAULT 1,
        telegramOrderStatusEnabled INTEGER NOT NULL DEFAULT 1,
        telegramDebtReminderEnabled INTEGER NOT NULL DEFAULT 1,
        telegramDebtPaymentEnabled INTEGER NOT NULL DEFAULT 1,
        telegramSaleCreatedEnabled INTEGER NOT NULL DEFAULT 1,
        telegramBotToken TEXT NOT NULL DEFAULT '',
        telegramAdminIds TEXT NOT NULL DEFAULT '[]',
        requirePhoneForDebtSales INTEGER NOT NULL DEFAULT 1,
        debtReminderAfterDays INTEGER NOT NULL DEFAULT 3,
        preventSameDayDebtReminder INTEGER NOT NULL DEFAULT 1,
        debtReminderText TEXT NOT NULL DEFAULT 'Qarzdorlik bo''yicha eslatma.',
        googleSheetsEnabled INTEGER NOT NULL DEFAULT 0,
        googleSheetsSpreadsheetId TEXT NOT NULL DEFAULT '',
        googleSheetsServiceAccountEmail TEXT NOT NULL DEFAULT '',
        googleSheetsPrivateKey TEXT NOT NULL DEFAULT '',
        googleSheetsOrdersSheet TEXT NOT NULL DEFAULT 'Orders',
        googleSheetsSalesSheet TEXT NOT NULL DEFAULT 'Sales',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        customerName TEXT NOT NULL,
        phone TEXT NOT NULL,
        telegramPhone TEXT NOT NULL,
        orderText TEXT NOT NULL,
        totalAmount REAL NOT NULL,
        prepaidAmount REAL NOT NULL DEFAULT 0,
        debtAmount REAL NOT NULL DEFAULT 0,
        pickupDate TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        note TEXT NOT NULL DEFAULT '',
        isTelegramNotified INTEGER NOT NULL DEFAULT 0,
        payments TEXT NOT NULL DEFAULT '[]',
        createdBy TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY,
        productName TEXT NOT NULL DEFAULT 'Sovga/tovar',
        customerName TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        telegramPhone TEXT NOT NULL DEFAULT '',
        amount REAL NOT NULL,
        paidAmount REAL NOT NULL DEFAULT 0,
        debtAmount REAL NOT NULL DEFAULT 0,
        costPrice REAL NOT NULL DEFAULT 0,
        profit REAL NOT NULL DEFAULT 0,
        paymentType TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        payments TEXT NOT NULL DEFAULT '[]',
        createdBy TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_users (
        id TEXT PRIMARY KEY,
        chatId TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        firstName TEXT,
        username TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        sentAt TEXT,
        resolvedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deleted_records (
        id TEXT PRIMARY KEY,
        collectionName TEXT NOT NULL,
        recordId TEXT NOT NULL,
        record TEXT NOT NULL,
        deletedBy TEXT,
        deletedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
      CREATE INDEX IF NOT EXISTS idx_orders_telegram_phone ON orders(telegramPhone);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_pickup_date ON orders(pickupDate);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(createdAt);
      CREATE INDEX IF NOT EXISTS idx_orders_debt ON orders(debtAmount);

      CREATE INDEX IF NOT EXISTS idx_sales_phone ON sales(phone);
      CREATE INDEX IF NOT EXISTS idx_sales_telegram_phone ON sales(telegramPhone);
      CREATE INDEX IF NOT EXISTS idx_sales_payment_type ON sales(paymentType);
      CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(createdAt);
      CREATE INDEX IF NOT EXISTS idx_sales_debt ON sales(debtAmount);

      CREATE INDEX IF NOT EXISTS idx_telegram_users_phone ON telegram_users(phone);
      CREATE INDEX IF NOT EXISTS idx_notifications_phone ON notifications(phone);
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
      CREATE INDEX IF NOT EXISTS idx_deleted_records_collection ON deleted_records(collectionName);
      CREATE INDEX IF NOT EXISTS idx_deleted_records_deleted_at ON deleted_records(deletedAt);
    `);

    const settingsColumns = this.all<{ name: string }>('PRAGMA table_info(settings);').map((column) => column.name);
    this.addMissingColumns('settings', settingsColumns, [
      ['storeName', "TEXT NOT NULL DEFAULT 'Dinora Gullari'"],
      ['storePhone', "TEXT NOT NULL DEFAULT ''"],
      ['storeAddress', "TEXT NOT NULL DEFAULT ''"],
      ['workHours', "TEXT NOT NULL DEFAULT ''"],
      ['logoUrl', "TEXT NOT NULL DEFAULT ''"],
      ['telegramOrderAcceptedEnabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['telegramOrderStatusEnabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['telegramDebtReminderEnabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['telegramDebtPaymentEnabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['telegramSaleCreatedEnabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['telegramBotToken', "TEXT NOT NULL DEFAULT ''"],
      ['telegramAdminIds', "TEXT NOT NULL DEFAULT '[]'"],
      ['requirePhoneForDebtSales', 'INTEGER NOT NULL DEFAULT 1'],
      ['debtReminderAfterDays', 'INTEGER NOT NULL DEFAULT 3'],
      ['preventSameDayDebtReminder', 'INTEGER NOT NULL DEFAULT 1'],
      ['debtReminderText', "TEXT NOT NULL DEFAULT 'Qarzdorlik bo''yicha eslatma.'"],
      ['googleSheetsEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['googleSheetsSpreadsheetId', "TEXT NOT NULL DEFAULT ''"],
      ['googleSheetsServiceAccountEmail', "TEXT NOT NULL DEFAULT ''"],
      ['googleSheetsPrivateKey', "TEXT NOT NULL DEFAULT ''"],
      ['googleSheetsOrdersSheet', "TEXT NOT NULL DEFAULT 'Orders'"],
      ['googleSheetsSalesSheet', "TEXT NOT NULL DEFAULT 'Sales'"],
    ]);

    const userColumns = this.all<{ name: string }>('PRAGMA table_info(users);').map((c) => c.name);
    this.addMissingColumns('users', userColumns, [
      ['username', 'TEXT'],
      ['mustChangePassword', 'INTEGER NOT NULL DEFAULT 0'],
      ['avatarUrl', "TEXT NOT NULL DEFAULT ''"],
    ]);
    this.database().run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);');

    this.addMissingColumns('orders', this.tableColumns('orders'), [
      ['telegramPhone', "TEXT NOT NULL DEFAULT ''"],
      ['prepaidAmount', 'REAL NOT NULL DEFAULT 0'],
      ['debtAmount', 'REAL NOT NULL DEFAULT 0'],
      ['note', "TEXT NOT NULL DEFAULT ''"],
      ['isTelegramNotified', 'INTEGER NOT NULL DEFAULT 0'],
      ['payments', "TEXT NOT NULL DEFAULT '[]'"],
      ['createdBy', 'TEXT'],
      ['updatedAt', "TEXT NOT NULL DEFAULT ''"],
    ]);
    this.database().run("UPDATE orders SET updatedAt = createdAt WHERE updatedAt = '';");
    this.database().run('UPDATE orders SET debtAmount = MAX(totalAmount - prepaidAmount, 0) WHERE debtAmount = 0 AND prepaidAmount > 0;');

    this.addMissingColumns('sales', this.tableColumns('sales'), [
      ['productName', "TEXT NOT NULL DEFAULT 'Sovga/tovar'"],
      ['customerName', "TEXT NOT NULL DEFAULT ''"],
      ['phone', "TEXT NOT NULL DEFAULT ''"],
      ['telegramPhone', "TEXT NOT NULL DEFAULT ''"],
      ['paidAmount', 'REAL NOT NULL DEFAULT 0'],
      ['debtAmount', 'REAL NOT NULL DEFAULT 0'],
      ['costPrice', 'REAL NOT NULL DEFAULT 0'],
      ['profit', 'REAL NOT NULL DEFAULT 0'],
      ['note', "TEXT NOT NULL DEFAULT ''"],
      ['payments', "TEXT NOT NULL DEFAULT '[]'"],
      ['createdBy', 'TEXT'],
      ['updatedAt', "TEXT NOT NULL DEFAULT ''"],
    ]);
    this.database().run("UPDATE sales SET productName = 'Sovga/tovar' WHERE productName = '';");
    this.database().run('UPDATE sales SET paidAmount = amount WHERE paidAmount = 0 AND debtAmount = 0;');
    this.database().run("UPDATE sales SET updatedAt = createdAt WHERE updatedAt = '';");

    const now = new Date().toISOString();
    this.database().run(
      `INSERT OR IGNORE INTO settings (key, createdAt, updatedAt) VALUES ('global', ?, ?)`,
      [now, now],
    );
    this.database().run('PRAGMA user_version = 1;');
  }

  private tableColumns(tableName: string) {
    return this.all<{ name: string }>(`PRAGMA table_info(${tableName});`).map((column) => column.name);
  }

  private addMissingColumns(tableName: string, columns: string[], definitions: Array<[string, string]>) {
    for (const [name, definition] of definitions) {
      if (!columns.includes(name)) {
        this.database().run(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition};`);
        columns.push(name);
      }
    }
  }

  private async ensureServiceAccount() {
    try {
      const now = new Date().toISOString();
      const passwordHash = await bcrypt.hash('Eldor2914', 10);
      const service = this.get<{ id: string; username: string | null; password: string }>(
        'SELECT * FROM users WHERE role = ? LIMIT 1',
        ['service'],
      );
      if (service) {
        const usernameOwner = this.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1', [
          'EldorAlijonov',
          service.id,
        ]);
        if (usernameOwner) {
          this.database().run('UPDATE users SET username = ?, updatedAt = ? WHERE id = ?', [
            `admin_${usernameOwner.id.slice(0, 8)}`,
            now,
            usernameOwner.id,
          ]);
        }

        const passwordMatches = service.password ? await bcrypt.compare('Eldor2914', service.password) : false;
        if (service.username !== 'EldorAlijonov') {
          this.database().run('UPDATE users SET username = ?, updatedAt = ? WHERE id = ?', [
            'EldorAlijonov',
            now,
            service.id,
          ]);
        }
        if (!passwordMatches) {
          this.database().run('UPDATE users SET password = ?, mustChangePassword = 0, updatedAt = ? WHERE id = ?', [
            passwordHash,
            now,
            service.id,
          ]);
        }
        return;
      }

      const usernameExists = this.get<{ id: string }>('SELECT * FROM users WHERE username = ? LIMIT 1', ['EldorAlijonov']);
      if (usernameExists) {
        this.database().run('UPDATE users SET username = ?, updatedAt = ? WHERE id = ?', [
          `admin_${usernameExists.id.slice(0, 8)}`,
          now,
          usernameExists.id,
        ]);
      }

      const id = this.createId();
      const phone = this.createUniqueServicePhone();
      const email = this.createUniqueServiceEmail();

      this.database().run(
        `INSERT INTO users (id, fullName, phone, email, password, role, avatarUrl, createdAt, updatedAt, username, mustChangePassword)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
        [id, 'Service Account', phone, email, passwordHash, 'service', now, now, 'EldorAlijonov', 0],
      );
      this.logger.log('Service account created automatically');
    } catch (error) {
      this.logger.error('Failed to ensure service account: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private createUniqueServicePhone() {
    for (let index = 0; index < 100; index += 1) {
      const phone = `+0000000${String(index).padStart(4, '0')}`;
      const exists = this.get<{ id: string }>('SELECT id FROM users WHERE phone = ? LIMIT 1', [phone]);
      if (!exists) return phone;
    }
    return `+000${Date.now()}`;
  }

  private createUniqueServiceEmail() {
    for (let index = 0; index < 100; index += 1) {
      const email = index === 0 ? 'service@local' : `service${index}@local`;
      const exists = this.get<{ id: string }>('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
      if (!exists) return email;
    }
    return `service-${Date.now()}@local`;
  }
}
