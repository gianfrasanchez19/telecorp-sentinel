import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloudRunAiClient } from '../src/ai/aiClient.js';
import { buildAwsSubjectToken, getCloudRunIdToken, resetWifCache, wifAudience, type WifConfig } from '../src/ai/gcpAuth.js';
import { deriveKeys } from '../src/lib/crypto.js';
import { setMasterKeyForLocal } from '../src/lib/secrets.js';

const cfg: WifConfig = { projectNumber: '123456789', poolId: 'aws-pool', providerId: 'aws-provider', serviceAccountEmail: 'ai-invoker@proj.iam.gserviceaccount.com', audience: 'https://ai-xyz.a.run.app', awsRegion: 'us-east-1' };
const fakeCreds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-de-prueba', sessionToken: 'token-de-sesion' });

describe('Workload Identity Federation AWS -> GCP', () => {
  it('construye el subject token firmado (GetCallerIdentity) con la audiencia del proveedor', async () => {
    const t = JSON.parse(decodeURIComponent(await buildAwsSubjectToken(cfg, fakeCreds)));
    expect(t.url).toBe('https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
    expect(t.method).toBe('POST');
    const h = Object.fromEntries(t.headers.map((x: { key: string; value: string }) => [x.key.toLowerCase(), x.value]));
    expect(h['x-goog-cloud-target-resource']).toBe(wifAudience(cfg));
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request/);
    expect(h['x-amz-security-token']).toBe('token-de-sesion');
  });

  it('intercambia en Google STS y pide un ID token con audiencia = URL de Cloud Run', async () => {
    resetWifCache();
    const calls: { url: string; body: any; auth?: string }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
      if (url.includes('sts.googleapis.com')) return new Response(JSON.stringify({ access_token: 'federado' }), { status: 200 });
      return new Response(JSON.stringify({ token: 'id-token' }), { status: 200 });
    }) as unknown as typeof fetch;
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-de-prueba';
    expect(await getCloudRunIdToken(cfg, fetchMock)).toBe('id-token');
    expect(calls[0].body.subjectTokenType).toBe('urn:ietf:params:aws:token-type:aws4_request');
    expect(calls[0].body.audience).toBe(wifAudience(cfg));
    expect(calls[1].url).toContain('ai-invoker%40proj.iam.gserviceaccount.com:generateIdToken');
    expect(calls[1].auth).toBe('Bearer federado');
    expect(calls[1].body.audience).toBe('https://ai-xyz.a.run.app');
  });
});

describe('modo alternativo HMAC (contrato con ai-service/app/security.py)', () => {
  it('firma ts.nonce.sha256(body) con la subclave derivada del secreto', async () => {
    const master = 'm'.repeat(48);
    setMasterKeyForLocal(master);
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return new Response(JSON.stringify({ summary: 's', probableCauses: [], recommendedActions: [], uncertainties: [], relatedProblemType: 'X', model: 'm', generatedAt: new Date().toISOString() }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new CloudRunAiClient({ url: 'https://ai.example', authMode: 'hmac' }, fetchMock);
    await c.analyze({ a: 1 }, 'req-1');
    const h = captured!.headers;
    const expected = createHmac('sha256', deriveKeys(master).aiHmac).update(`${h['x-sentinel-timestamp']}.${h['x-sentinel-nonce']}.${createHash('sha256').update(captured!.body).digest('hex')}`).digest('hex');
    expect(h['x-sentinel-signature']).toBe(expected);
  });

  it('5xx => AiTransientError (reintentable); 4xx/esquema inválido => AiUnavailableError', async () => {
    setMasterKeyForLocal('m'.repeat(48));
    const mk = (status: number, body: unknown) => new CloudRunAiClient({ url: 'https://ai.example', authMode: 'hmac' }, (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    await expect(mk(503, {}).analyze({}, 'r')).rejects.toMatchObject({ name: 'AiTransientError' });
    await expect(mk(401, {}).analyze({}, 'r')).rejects.toMatchObject({ name: 'AiUnavailableError' });
    await expect(mk(200, { summary: 1 }).analyze({}, 'r')).rejects.toMatchObject({ name: 'AiUnavailableError' });
  });
});
