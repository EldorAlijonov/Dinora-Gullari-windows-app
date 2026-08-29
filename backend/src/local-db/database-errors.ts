export type DatabaseErrorCode =
  | 'DATABASE_CORRUPTED'
  | 'DATABASE_RECOVERED_FROM_BACKUP'
  | 'DATABASE_BACKUP_NOT_FOUND'
  | 'DATABASE_WRITE_FAILED'
  | 'DATABASE_SCHEMA_INVALID'
  | 'DATABASE_RESTORE_FAILED'
  | 'DATABASE_MIGRATION_FAILED'
  | 'DATABASE_IMPORT_INVALID'
  | 'DATABASE_IMPORT_FAILED';

export class LocalDatabaseError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: DatabaseErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LocalDatabaseError';
    if (cause) {
      this.cause = cause;
    }
  }
}
