/**
 * Semilla REPRODUCIBLE para modo local: crea operador/ingesta de demo y datos
 * sintéticos (telemetría normal, una antena caída en zona hospitalaria, un
 * colectivo con antenas normales y recurrencia). Uso: npm run seed [-- --reset]
 * La contraseña del operador local se toma de LOCAL_OPERATOR_PASSWORD o se genera
 * y se guarda en .local/operator-credentials.txt (ignorado por git).
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createUser } from '../services/auth.js';
import { runScenario } from '../services/simulator.js';
import { ingestTelemetry } from '../services/telemetry.js';
import { ANTENNAS } from '../domain/catalog.js';
import { createLocalEnv, loadOrCreateLocalMasterKey } from './localRuntime.js';
import { LOCAL_DB, LOCAL_DIR, LOCAL_MAIL } from './paths.js';

process.env.LOG_SILENT = '1';
if (process.argv.includes('--reset')) rmSync(LOCAL_DB, { force: true });
mkdirSync(LOCAL_DIR, { recursive: true });
const env = createLocalEnv({ dataFile: LOCAL_DB, mailDir: LOCAL_MAIL, masterKey: loadOrCreateLocalMasterKey(LOCAL_DIR) });

const credFile = join(LOCAL_DIR, 'operator-credentials.txt');
let password = process.env.LOCAL_OPERATOR_PASSWORD;
if (!password) password = existsSync(credFile) ? readFileSync(credFile, 'utf8').split('\n').find((l) => l.startsWith('password='))?.slice(9) : undefined;
if (!password) password = randomBytes(12).toString('base64url');
const username = process.env.LOCAL_OPERATOR_USER ?? 'operador.demo';
await createUser(username, password, 'OPERADOR', 'Operador de demostración');
await createUser('ingesta.demo', randomBytes(16).toString('base64url'), 'INGESTA', 'Dispositivo de ingesta (demo)');
writeFileSync(credFile, `# SOLO LOCAL — no subir a git\nusername=${username}\npassword=${password}\n`, { mode: 0o600 });

// 30 minutos de telemetría normal (sintética) para todas las antenas
const now = Date.now();
for (let m = 30; m >= 1; m--) {
  const minute = new Date(Math.floor((now - m * 60_000) / 60_000) * 60_000).toISOString();
  for (const a of ANTENNAS) {
    const v = 70 + ((m * 7 + a.antennaId.length * 13) % 50);
    await ingestTelemetry({ eventId: `seed-${a.antennaId}-${minute.replace(/\D/g, '').slice(0, 12)}`, antennaId: a.antennaId, zoneId: a.zoneId, gbPerMinute: v, observedAt: minute, synthetic: true });
  }
}
await env.idle(120_000);
console.log('✓ telemetría base');
console.log('✓', JSON.stringify(await runScenario('recurrencia', { antennaId: 'ANT-VIN-02' })).slice(0, 80));
await env.idle(60_000);
console.log('✓', JSON.stringify(await runScenario('antena-inhabilitada', { antennaId: 'ANT-SRN-01', minutes: 120 })).slice(0, 80));
await env.idle(60_000);
console.log('✓', JSON.stringify(await runScenario('reportes-usuarios', { zoneId: 'Z-SRN', count: 4, startIndex: 0 })).slice(0, 80));
console.log('✓', JSON.stringify(await runScenario('reportes-usuarios', { zoneId: 'Z-LPA', count: 10, startIndex: 0 })).slice(0, 80));
await env.idle(60_000);
env.store.flush();
console.log(`\nSemilla local lista en .local/db.json. Credenciales del operador LOCAL en .local/operator-credentials.txt (usuario: ${username}).`);
process.exit(0);
