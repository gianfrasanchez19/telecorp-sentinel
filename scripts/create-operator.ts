/**
 * Crea (o reemplaza) un usuario operador en la tabla DynamoDB desplegada.
 * La contraseña se lee de OPERATOR_PASSWORD (nunca se imprime ni se guarda en git).
 * Uso: OPERATOR_PASSWORD=... TABLE_NAME=... AWS_REGION=... npx tsx scripts/create-operator.ts <usuario> [OPERADOR|INGESTA]
 */
import { createUser, type Role } from '../backend/src/services/auth.js';
import { baseConfig, setRuntime } from '../backend/src/services/runtime.js';
import { DynamoStore } from '../backend/src/store/dynamoStore.js';

const [username, role = 'OPERADOR'] = process.argv.slice(2);
const password = process.env.OPERATOR_PASSWORD;
if (!username || !password || !process.env.TABLE_NAME) {
  console.error('Uso: OPERATOR_PASSWORD=... TABLE_NAME=... npx tsx scripts/create-operator.ts <usuario> [OPERADOR|INGESTA]');
  process.exit(2);
}
setRuntime({ mode: 'aws', store: new DynamoStore(process.env.TABLE_NAME), ...baseConfig(), now: () => new Date() } as never);
await createUser(username, password, role as Role, role === 'OPERADOR' ? 'Operador NOC' : 'Dispositivo de ingesta');
console.log(`Usuario '${username}' (${role}) creado en ${process.env.TABLE_NAME}.`);
