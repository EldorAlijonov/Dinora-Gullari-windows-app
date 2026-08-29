import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import initSqlJs, { BindParams, Database, SqlJsStatic } from 'sql.js';
import { getLocalDataDir, getLocalDatabasePath } from '../local-app/paths';
import { LocalDatabaseError } from './database-errors';

type SqlParam = string | number | boolean | null | Uint8Array;
type SqlParams = SqlParam[] | BindParams;
type ValidationResult = { ok: true; size: number; tables: string[] } | { ok: false; size: number; reason: string };

const criticalTables = ['users', 'settings', 'orders', 'sales', 'telegram_users', 'notifications', 'deleted_records'];
const backupRetentionLimit = 50;

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
  private readonly logsDir = join(getLocalDataDir(), 'logs');
  private readonly recoveryNoticePath = join(this.logsDir, 'database-recovery-notice.json');
  private readonly startupErrorPath = join(this.logsDir, 'backend-startup-error.json');
  private migrationBackupCreated = false;

  async onModuleInit() {
    await this.open();
  }

  onModuleDestroy() {
    try {
      this.persist();
    } catch (error) {
      this.logDatabaseEvent('persist failed during shutdown', { error: this.errorMessage(error) });
    }
    this.db?.close();
  }

  async open() {
    if (this.db) return;

    const wasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
    this.sql = await initSqlJs({
      locateFile: (file) => join(wasmDir, file),
    });

    mkdirSync(dirname(this.databasePath), { recursive: true });
    mkdirSync(this.paths.backups, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.clearStartupError();
    this.logDatabaseEvent('database startup validation started', {
      databasePath: this.databasePath,
      exists: existsSync(this.databasePath),
      size: this.safeSize(this.databasePath),
    });

    this.recoverInterruptedReplace();
    const existing = existsSync(this.databasePath);
    if (existing) {
      const validation = this.validateDatabaseFile(this.databasePath, { requireApplicationSchema: false });
      this.logDatabaseEvent('primary database validation completed', validation);
      if (!validation.ok) {
        await this.recoverPrimaryDatabase(validation.reason);
      } else {
        this.db = new this.sql.Database(readFileSync(this.databasePath));
      }
    } else {
      this.logDatabaseEvent('database file missing; creating first-install database', {});
      this.db = new this.sql.Database();
    }

    this.database().run('PRAGMA foreign_keys = ON;');
    try {
      if (existing && !this.migrationBackupCreated) {
        this.createVerifiedBackup('pre-migration');
        this.migrationBackupCreated = true;
      }
      this.logDatabaseEvent('migration started', {});
      await this.migrate();
      this.logDatabaseEvent('migration completed', {});
    } catch (error) {
      const dbError = new LocalDatabaseError('DATABASE_MIGRATION_FAILED', 'Database migration failed', {}, error);
      this.writeStartupError(dbError);
      throw dbError;
    }
    await this.ensureServiceAccount();
    this.persist();
    this.logger.log(`Local SQLite database ready: ${this.databasePath}`);
  }

  async replaceDatabaseFromFile(sourcePath: string) {
    this.logDatabaseEvent('database import validation started', { sourcePath, size: this.safeSize(sourcePath) });
    const validation = this.validateDatabaseFile(sourcePath, { requireApplicationSchema: true });
    if (!validation.ok) {
      this.logDatabaseEvent('database import rejected', { reason: validation.reason });
      throw new LocalDatabaseError('DATABASE_IMPORT_INVALID', `Import database is invalid: ${validation.reason}`);
    }

    this.createVerifiedBackup('pre-import');
    const current = this.database();
    current.close();
    this.db = undefined;

    try {
      this.safeReplaceDatabaseFromFile(sourcePath, 'import');
      this.db = new this.sql!.Database(readFileSync(this.databasePath));
      this.database().run('PRAGMA foreign_keys = ON;');
      await this.migrate();
      await this.ensureServiceAccount();
      this.persist();
      this.logDatabaseEvent('database import completed', {});
    } catch (error) {
      this.db = new this.sql!.Database(readFileSync(this.databasePath));
      const dbError =
        error instanceof LocalDatabaseError
          ? error
          : new LocalDatabaseError('DATABASE_IMPORT_FAILED', 'Database import failed', {}, error);
      this.logDatabaseEvent('database import failed', { error: this.errorMessage(dbError) });
      throw dbError;
    }
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
    this.logDatabaseEvent('persist started', { databasePath: this.databasePath });
    let exported: Buffer;
    try {
      exported = Buffer.from(this.db.export());
    } catch (error) {
      throw new LocalDatabaseError('DATABASE_WRITE_FAILED', 'Failed to export SQL.js database', {}, error);
    }

    const tmpPath = `${this.databasePath}.tmp`;
    try {
      this.writeFileFully(tmpPath, exported);
      this.logDatabaseEvent('persist tmp write completed', { tmpPath, size: exported.length });
    } catch (error) {
      this.cleanupFile(tmpPath);
      this.logDatabaseEvent('persist tmp write failed', { error: this.errorMessage(error) });
      throw new LocalDatabaseError('DATABASE_WRITE_FAILED', 'Failed to write temporary database file', {}, error);
    }

    const tmpValidation = this.validateDatabaseFile(tmpPath, { requireApplicationSchema: false });
    this.logDatabaseEvent('persist tmp validation completed', tmpValidation);
    if (!tmpValidation.ok) {
      const failedTmpPath = `${this.databasePath}.invalid-tmp-${this.timestamp()}.sqlite`;
      try {
        renameSync(tmpPath, failedTmpPath);
      } catch {
        this.cleanupFile(tmpPath);
      }
      throw new LocalDatabaseError('DATABASE_WRITE_FAILED', `Temporary database validation failed: ${tmpValidation.reason}`, {
        failedTmpPath,
      });
    }

    this.safeReplaceDatabaseFromFile(tmpPath, 'persist', { sourceIsTemporary: true });
    this.enforceBackupRetention();
    this.logDatabaseEvent('persist completed', { size: this.safeSize(this.databasePath) });
  }

  validateDatabaseFile(filePath: string, options: { requireApplicationSchema: boolean }): ValidationResult {
    const size = this.safeSize(filePath);
    if (!existsSync(filePath)) return { ok: false, size, reason: 'file_missing' };
    if (size <= 0) return { ok: false, size, reason: 'file_empty' };
    if (!this.sql) return { ok: false, size, reason: 'sql_js_not_initialized' };

    let candidate: Database | undefined;
    try {
      candidate = new this.sql.Database(readFileSync(filePath));
      const integrity = candidate.exec('PRAGMA integrity_check;')?.[0]?.values?.[0]?.[0];
      if (integrity !== 'ok') {
        return { ok: false, size, reason: `integrity_check_failed:${String(integrity || 'empty')}` };
      }
      const tables = this.readTables(candidate);
      if (options.requireApplicationSchema && !criticalTables.some((table) => tables.includes(table))) {
        return { ok: false, size, reason: 'application_schema_missing' };
      }
      const missing = criticalTables.filter((table) => !tables.includes(table));
      if (missing.length && tables.length) {
        this.logDatabaseEvent('database schema compatibility warning', {
          filePath,
          missingTables: missing,
          note: 'migration may add missing compatible tables',
        });
      }
      return { ok: true, size, tables };
    } catch (error) {
      return { ok: false, size, reason: this.errorMessage(error) };
    } finally {
      candidate?.close();
    }
  }

  private database() {
    if (!this.db) throw new Error('Local database has not been opened');
    return this.db;
  }

  private async recoverPrimaryDatabase(reason: string) {
    this.logDatabaseEvent('corruption detected', { reason });
    const corruptPath = this.preserveCorruptDatabase();
    const backup = this.findNewestHealthyBackup();

    if (!backup) {
      const error = new LocalDatabaseError('DATABASE_BACKUP_NOT_FOUND', 'Primary database is corrupt and no healthy backup was found', {
        corruptPath,
      });
      this.writeStartupError(error);
      throw error;
    }

    try {
      this.logDatabaseEvent('restore started', { backupPath: backup.path, backupCreatedAt: backup.createdAt, corruptPath });
      this.safeReplaceDatabaseFromFile(backup.path, 'recovery');
      const restoredValidation = this.validateDatabaseFile(this.databasePath, { requireApplicationSchema: true });
      this.logDatabaseEvent('restored database validation completed', restoredValidation);
      if (!restoredValidation.ok) {
        throw new LocalDatabaseError('DATABASE_RESTORE_FAILED', `Restored database is invalid: ${restoredValidation.reason}`, {
          backupPath: backup.path,
          corruptPath,
        });
      }
      this.db = new this.sql!.Database(readFileSync(this.databasePath));
      this.writeRecoveryNotice({
        code: 'DATABASE_RECOVERED_FROM_BACKUP',
        message: "Ma'lumotlar bazasida muammo aniqlandi. Dastur eng so'nggi sog'lom zaxira nusxadan muvaffaqiyatli tiklandi.",
        backupPath: backup.path,
        backupCreatedAt: backup.createdAt,
        corruptPath,
      });
      this.logDatabaseEvent('restore completed', { backupPath: backup.path });
    } catch (error) {
      const dbError =
        error instanceof LocalDatabaseError
          ? error
          : new LocalDatabaseError('DATABASE_RESTORE_FAILED', 'Failed to restore database from backup', { corruptPath }, error);
      this.writeStartupError(dbError);
      throw dbError;
    }
  }

  private preserveCorruptDatabase() {
    const preservedPath = join(dirname(this.databasePath), `dinora-gullari.corrupt-${this.timestamp()}.sqlite`);
    copyFileSync(this.databasePath, preservedPath);
    this.logDatabaseEvent('corrupt database preserved', { preservedPath, size: this.safeSize(preservedPath) });
    return preservedPath;
  }

  private findNewestHealthyBackup() {
    mkdirSync(this.paths.backups, { recursive: true });
    const files = readdirSync(this.paths.backups)
      .filter((file) => file.toLowerCase().endsWith('.sqlite'))
      .map((file) => {
        const path = join(this.paths.backups, file);
        const stats = statSync(path);
        return { path, file, mtimeMs: stats.mtimeMs, createdAt: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    this.logDatabaseEvent('backup scan started', { backupDir: this.paths.backups, count: files.length });
    for (const backup of files) {
      const validation = this.validateDatabaseFile(backup.path, { requireApplicationSchema: true });
      if (validation.ok) {
        this.logDatabaseEvent('healthy backup selected', { backupPath: backup.path, createdAt: backup.createdAt, size: validation.size });
        return backup;
      }
      this.logDatabaseEvent('backup rejected', { backupPath: backup.path, reason: validation.reason, size: validation.size });
    }
    return null;
  }

  createVerifiedBackup(reason = 'manual') {
    const validation = this.validateDatabaseFile(this.databasePath, { requireApplicationSchema: false });
    if (!validation.ok) {
      this.logDatabaseEvent('backup skipped because source database is not healthy', { reason, validation });
      throw new LocalDatabaseError('DATABASE_CORRUPTED', `Cannot back up unhealthy database: ${validation.reason}`);
    }

    mkdirSync(this.paths.backups, { recursive: true });
    const backupPath = join(this.paths.backups, `dinora-backup-${this.timestamp()}.sqlite`);
    copyFileSync(this.databasePath, backupPath);
    const backupValidation = this.validateDatabaseFile(backupPath, { requireApplicationSchema: false });
    if (!backupValidation.ok) {
      this.cleanupFile(backupPath);
      throw new LocalDatabaseError('DATABASE_WRITE_FAILED', `Created backup failed validation: ${backupValidation.reason}`);
    }
    this.logDatabaseEvent('verified backup created', { reason, backupPath, size: backupValidation.size });
    this.enforceBackupRetention();
    return backupPath;
  }

  private safeReplaceDatabaseFromFile(sourcePath: string, reason: string, options: { sourceIsTemporary?: boolean } = {}) {
    const oldPath = `${this.databasePath}.replace-old-${this.timestamp()}`;
    const failedNewPath = `${this.databasePath}.replace-failed-${this.timestamp()}`;
    let movedOld = false;
    let installedNew = false;

    try {
      this.logDatabaseEvent('atomic replace started', { reason, sourcePath, databasePath: this.databasePath });
      if (existsSync(this.databasePath)) {
        renameSync(this.databasePath, oldPath);
        movedOld = true;
      }

      if (options.sourceIsTemporary) {
        renameSync(sourcePath, this.databasePath);
      } else {
        copyFileSync(sourcePath, `${this.databasePath}.restore-tmp`);
        renameSync(`${this.databasePath}.restore-tmp`, this.databasePath);
      }
      installedNew = true;

      const finalValidation = this.validateDatabaseFile(this.databasePath, { requireApplicationSchema: false });
      if (!finalValidation.ok) {
        throw new LocalDatabaseError('DATABASE_RESTORE_FAILED', `Installed database validation failed: ${finalValidation.reason}`);
      }

      if (movedOld) {
        const safetyPath = `${this.databasePath}.previous-${this.timestamp()}`;
        renameSync(oldPath, safetyPath);
        this.logDatabaseEvent('previous database preserved after replace', { safetyPath });
        this.cleanupPreviousDatabaseCopies();
      }
      this.logDatabaseEvent('atomic replace completed', { reason, size: finalValidation.size });
    } catch (error) {
      this.logDatabaseEvent('atomic replace failed; rollback started', { reason, error: this.errorMessage(error) });
      if (installedNew && existsSync(this.databasePath)) {
        try {
          renameSync(this.databasePath, failedNewPath);
        } catch {
          // Keep going and attempt to put the old database back.
        }
      }
      if (movedOld && existsSync(oldPath) && !existsSync(this.databasePath)) {
        renameSync(oldPath, this.databasePath);
      }
      if (!options.sourceIsTemporary) {
        this.cleanupFile(`${this.databasePath}.restore-tmp`);
      }
      throw error instanceof LocalDatabaseError
        ? error
        : new LocalDatabaseError('DATABASE_RESTORE_FAILED', 'Database replace failed', { reason }, error);
    }
  }

  private recoverInterruptedReplace() {
    if (existsSync(this.databasePath)) return;
    const dir = dirname(this.databasePath);
    const prefix = `${basename(this.databasePath)}.replace-old-`;
    const candidates = readdirSync(dir)
      .filter((file) => file.startsWith(prefix))
      .map((file) => join(dir, file))
      .sort((a, b) => this.safeMtimeMs(b) - this.safeMtimeMs(a));
    const candidate = candidates.find((file) => this.validateDatabaseFile(file, { requireApplicationSchema: false }).ok);
    if (!candidate) return;
    copyFileSync(candidate, this.databasePath);
    this.logDatabaseEvent('interrupted replace recovered from previous database', { candidate });
  }

  private writeFileFully(filePath: string, data: Buffer) {
    const fd = openSync(filePath, 'w');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private readTables(database: Database) {
    const rows = database.exec("SELECT name FROM sqlite_master WHERE type = 'table';")?.[0]?.values || [];
    return rows.map((row) => String(row[0]));
  }

  private enforceBackupRetention() {
    const files = readdirSync(this.paths.backups)
      .filter((file) => file.toLowerCase().endsWith('.sqlite'))
      .map((file) => join(this.paths.backups, file))
      .sort((a, b) => this.safeMtimeMs(b) - this.safeMtimeMs(a));
    const healthyKept = new Set(files.slice(0, backupRetentionLimit));
    for (const file of files.slice(backupRetentionLimit)) {
      if (healthyKept.has(file)) continue;
      try {
        unlinkSync(file);
        this.logDatabaseEvent('old backup removed by retention', { file });
      } catch (error) {
        this.logDatabaseEvent('old backup retention cleanup failed', { file, error: this.errorMessage(error) });
      }
    }
  }

  private writeRecoveryNotice(payload: Record<string, unknown>) {
    writeFileSync(this.recoveryNoticePath, JSON.stringify({ ...payload, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  }

  private writeStartupError(error: LocalDatabaseError) {
    writeFileSync(
      this.startupErrorPath,
      JSON.stringify(
        {
          code: error.code,
          message: error.message,
          details: error.details,
          logPath: join(this.logsDir, 'database.log'),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private clearStartupError() {
    this.cleanupFile(this.startupErrorPath);
  }

  private logDatabaseEvent(message: string, details: Record<string, unknown> = {}) {
    mkdirSync(this.logsDir, { recursive: true });
    const sanitized = { ...details };
    for (const key of Object.keys(sanitized)) {
      if (/password|token|secret|privatekey/i.test(key)) {
        sanitized[key] = '[redacted]';
      }
    }
    const line = `${new Date().toISOString()} ${message} ${JSON.stringify(sanitized)}\n`;
    appendFileSync(join(this.logsDir, 'database.log'), line);
    this.logger.log(message);
  }

  private safeSize(filePath: string) {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private safeMtimeMs(filePath: string) {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private cleanupFile(filePath: string) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // best effort cleanup
    }
  }

  private timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private cleanupPreviousDatabaseCopies() {
    const dir = dirname(this.databasePath);
    const prefix = `${basename(this.databasePath)}.previous-`;
    const files = readdirSync(dir)
      .filter((file) => file.startsWith(prefix))
      .map((file) => join(dir, file))
      .sort((a, b) => this.safeMtimeMs(b) - this.safeMtimeMs(a));

    for (const file of files.slice(5)) {
      try {
        unlinkSync(file);
      } catch (error) {
        this.logDatabaseEvent('previous database cleanup failed', { file, error: this.errorMessage(error) });
      }
    }
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
