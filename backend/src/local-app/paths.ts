import { mkdirSync } from 'fs';
import { join, resolve } from 'path';

const appFolderName = 'Dinora Gullari';

export function getLocalDataDir() {
  const configured = process.env.DINORA_DATA_DIR;
  const baseDir = configured || join(process.env.APPDATA || process.cwd(), appFolderName);
  const resolved = resolve(baseDir);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function getLocalDatabasePath() {
  return resolve(process.env.LOCAL_DATABASE_PATH || join(getLocalDataDir(), 'dinora-gullari.sqlite'));
}
