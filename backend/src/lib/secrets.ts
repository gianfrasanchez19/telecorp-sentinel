import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { deriveKeys, type DerivedKeys } from './crypto.js';

/**
 * Obtiene la clave maestra desde AWS Secrets Manager (SECRET_ARN) con caché en
 * memoria (TTL 5 min) para no llamar al servicio en cada invocación.
 * En modo local se usa LOCAL_MASTER_KEY (archivo .local/ ignorado por git).
 */
let cache: { keys: DerivedKeys; at: number } | undefined;
const TTL_MS = 5 * 60_000;
let override: string | undefined;

/** Sólo pruebas/local. */
export function setMasterKeyForLocal(master: string): void {
  override = master;
  cache = undefined;
}

export async function getKeys(): Promise<DerivedKeys> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.keys;
  let master: string | undefined = override ?? process.env.LOCAL_MASTER_KEY;
  if (!master) {
    const arn = process.env.SECRET_ARN;
    if (!arn) throw new Error('SECRET_ARN no configurado');
    const sm = new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!r.SecretString) throw new Error('Secreto vacío');
    const parsed = JSON.parse(r.SecretString) as { master?: string };
    master = parsed.master;
  }
  const keys = deriveKeys(master ?? '');
  cache = { keys, at: Date.now() };
  return keys;
}
