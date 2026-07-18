declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface BindParams {
    [key: string]: unknown;
  }

  export class Statement {
    bind(values?: unknown[] | BindParams): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array);
    run(sql: string, params?: unknown[] | BindParams): Database;
    exec(sql: string, params?: unknown[] | BindParams): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
}
