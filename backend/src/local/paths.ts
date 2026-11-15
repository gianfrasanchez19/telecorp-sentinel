import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Carpeta de datos locales (ignorada por git): base emulada, buzón y clave local. */
export const LOCAL_DIR = resolve(here, '../../../.local');
export const LOCAL_DB = resolve(LOCAL_DIR, 'db.json');
export const LOCAL_MAIL = resolve(LOCAL_DIR, 'mailbox');
