import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

/**
 * Autenticación AWS -> Google Cloud SIN claves de cuenta de servicio:
 * Workload Identity Federation (proveedor AWS).
 *
 *  1. Firmamos (SigV4) una solicitud sts:GetCallerIdentity con las credenciales
 *     temporales del rol de la Lambda (en AWS Academy: LabRole).
 *  2. Google STS valida esa firma contra AWS y entrega un token federado.
 *  3. Con el token federado pedimos a IAM Credentials un ID token (OIDC) de la
 *     cuenta de servicio "invoker", con audiencia = URL de Cloud Run.
 *  4. Cloud Run (privado, --no-allow-unauthenticated) valida ese ID token.
 *
 * Documentación oficial: https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds
 */
export interface WifConfig {
  projectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccountEmail: string;
  audience: string; // URL de Cloud Run
  awsRegion: string;
}

let cached: { token: string; exp: number } | undefined;

export function wifAudience(c: WifConfig): string {
  return `//iam.googleapis.com/projects/${c.projectNumber}/locations/global/workloadIdentityPools/${c.poolId}/providers/${c.providerId}`;
}

/** Construye el "subject token" serializado según el formato que espera Google STS. */
export async function buildAwsSubjectToken(c: WifConfig, fetchCreds = defaultProvider()): Promise<string> {
  const host = `sts.${c.awsRegion}.amazonaws.com`;
  const signer = new SignatureV4({ credentials: fetchCreds, region: c.awsRegion, service: 'sts', sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST',
    protocol: 'https:',
    hostname: host,
    path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host, 'x-goog-cloud-target-resource': wifAudience(c) },
  });
  const headers = Object.entries(signed.headers).map(([key, value]) => ({ key, value }));
  const token = { url: `https://${host}?Action=GetCallerIdentity&Version=2011-06-15`, method: 'POST', headers };
  return encodeURIComponent(JSON.stringify(token));
}

export async function getCloudRunIdToken(c: WifConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cached && cached.exp - 120_000 > Date.now()) return cached.token;
  const subjectToken = await buildAwsSubjectToken(c);
  const stsRes = await fetchImpl('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audience: wifAudience(c),
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subjectTokenType: 'urn:ietf:params:aws:token-type:aws4_request',
      subjectToken,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!stsRes.ok) throw new Error(`Google STS rechazó el intercambio (${stsRes.status})`);
  const { access_token } = (await stsRes.json()) as { access_token: string };
  const idRes = await fetchImpl(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(c.serviceAccountEmail)}:generateIdToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ audience: c.audience, includeEmail: true }),
    signal: AbortSignal.timeout(5000),
  });
  if (!idRes.ok) throw new Error(`IAM Credentials no emitió el ID token (${idRes.status})`);
  const { token } = (await idRes.json()) as { token: string };
  cached = { token, exp: Date.now() + 55 * 60_000 };
  return token;
}

export function resetWifCache(): void {
  cached = undefined;
}
