/**
 * Imprime en stdout (para canalizar a `gcloud secrets versions add --data-file=-`)
 * la subclave HMAC del servicio IA derivada del secreto de AWS Secrets Manager.
 * No la escribe en disco ni en logs. Uso exclusivo de infra/gcp/enable-hmac-fallback.sh.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { deriveKeys } from '../backend/src/lib/crypto.js';

const id = process.env.AWS_SECRET_ID;
if (!id) throw new Error('AWS_SECRET_ID requerido');
const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: id }));
const master = (JSON.parse(r.SecretString ?? '{}') as { master?: string }).master ?? '';
process.stdout.write(deriveKeys(master).aiHmac.toString('hex'));
