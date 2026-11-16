import { describe, expect, it } from 'vitest';
import { resolveAsset, SECURITY_HEADERS, webApp } from '../src/aws/web.js';

const ev = (rawPath: string) => ({ rawPath }) as never;

describe('portal servido por API Gateway (webApp)', () => {
  it('bloquea path traversal (nunca sale del directorio del frontend)', () => {
    for (const p of ['/../../etc/passwd', '/..%2F..%2Fpackage.json', '/assets/../../../serverless.yml']) {
      const r = resolveAsset(p);
      expect(r.file.endsWith('index.html')).toBe(true);
      expect(r.spaFallback).toBe(true);
    }
  });

  it('rutas del cliente usan la SPA; un recurso con extensión inexistente da 404 real', async () => {
    expect(resolveAsset('/operador/incidentes').spaFallback).toBe(true);
    const r = await webApp(ev('/assets/no-existe.js'));
    expect(r.statusCode).toBe(404);
  });

  it('incluye CSP estricta, HSTS y anti-framing en todas las respuestas', async () => {
    const r = await webApp(ev('/assets/no-existe.js'));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect((r.headers as Record<string, string>)[k]).toBe(v);
    expect(SECURITY_HEADERS['content-security-policy']).toContain("script-src 'self'");
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['content-security-policy']).not.toContain('unsafe-eval');
  });
});
