import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { mkdir, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { LocalDatabaseService } from '../../local-db/local-database.service';

const exportCollections = ['orders', 'sales', 'users', 'notifications', 'telegram_users', 'appsettings', 'deleted_records'];

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly localDatabase: LocalDatabaseService,
    private readonly config: ConfigService,
  ) {}

  async createExportPayload() {
    if (!this.localDatabase) {
      throw new ServiceUnavailableException('Database connection is not ready');
    }

    const exported = await this.localDatabase.exportCollections();
    const data = Object.fromEntries(exportCollections.map((collectionName) => [collectionName, exported[collectionName] || []]));

    return {
      metadata: {
        app: 'dinora-gullari',
        createdAt: new Date().toISOString(),
        databaseName: 'SQLite',
        collections: exportCollections,
      },
      data,
    };
  }

  async createBackupFile() {
    const payload = await this.createExportPayload();
    const backupDir = this.backupDir();
    await mkdir(backupDir, { recursive: true });
    const filename = `dinora-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = join(backupDir, filename);
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    const sqlitePath = this.localDatabase.createVerifiedBackup('scheduled-or-manual');
    const sqliteFilename = sqlitePath.split(/[\\/]/).pop() || filename.replace(/\.json$/, '.sqlite');
    return { filename, sqliteFilename, filePath, createdAt: payload.metadata.createdAt };
  }

  async listBackupFiles() {
    const backupDir = this.backupDir();
    await mkdir(backupDir, { recursive: true });
    const files = await readdir(backupDir);
    const backups = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          const fileStat = await stat(join(backupDir, file));
          return { filename: file, size: fileStat.size, createdAt: fileStat.birthtime };
        }),
    );
    return backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  findDeletedRecords() {
    return this.localDatabase
      .all<Record<string, unknown>>('SELECT * FROM deleted_records ORDER BY deletedAt DESC LIMIT 100')
      .map((record) => ({
        ...record,
        _id: record.id,
        collection: record.collectionName,
        record: this.parseJson(record.record),
        deletedAt: record.deletedAt ? new Date(String(record.deletedAt)) : undefined,
        createdAt: record.createdAt ? new Date(String(record.createdAt)) : undefined,
        updatedAt: record.updatedAt ? new Date(String(record.updatedAt)) : undefined,
      }));
  }

  @Cron('0 3 * * *', { timeZone: 'Asia/Tashkent' })
  async runDailyBackup() {
    if (this.config.get<string>('BACKUP_ENABLED') === 'false') return;

    try {
      const backup = await this.createBackupFile();
      this.logger.log(`Daily SQLite backup created: ${backup.filename}`);
    } catch (error) {
      this.logger.error('Daily SQLite backup failed', error instanceof Error ? error.stack : undefined);
    }
  }

  private backupDir() {
    return this.config.get<string>('BACKUP_DIR') || this.localDatabase.paths.backups || join(process.cwd(), 'backups');
  }

  private parseJson(value: unknown) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
}
