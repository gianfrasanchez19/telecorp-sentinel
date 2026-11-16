import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { ErrorState, Loading } from '../components/ui';
import { useApi } from '../hooks';
import type { Catalog } from '../types';

interface Result {
  ticketId: string;
  token: string;
  status: string;
  receivedAt: string;
  duplicate: boolean;
}

/** Clave aleatoria de 128 bits; getRandomValues funciona también fuera de HTTPS (sitio web S3). */
function newIdemKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function localNowInput(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export default function ReportPage() {
  const catalog = useApi<Catalog>('/catalog');
  // Clave de idempotencia estable mientras el formulario esté abierto: reintentos no duplican.
  const [idemKey, setIdemKey] = useState(newIdemKey);
  const [form, setForm] = useState({ documentType: 'DNI', documentNumber: '', serviceNumber: '', zoneId: '', locationHint: '', occurredAt: localNowInput(), problemType: 'SIN_SENAL', description: '', email: '', phone: '', notifyConsent: false });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [result, setResult] = useState<Result>();
  const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string; checked?: boolean; type?: string } }) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const fieldErrors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const i of (error?.details as { path?: string[]; message: string }[] | undefined) ?? []) if (i.path?.length) m[i.path[0]] = i.message;
    return m;
  }, [error]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(undefined);
    try {
      const body = {
        documentType: form.documentType,
        documentNumber: form.documentNumber,
        serviceNumber: form.serviceNumber,
        zoneId: form.zoneId,
        locationHint: form.locationHint || undefined,
        occurredAt: new Date(form.occurredAt).toISOString(),
        problemType: form.problemType,
        description: form.description,
        contact: form.email || form.phone ? { email: form.email || undefined, phone: form.phone || undefined } : undefined,
        notifyConsent: form.notifyConsent,
        idempotencyKey: idemKey,
      };
      setResult(await api<Result>('/reports', { method: 'POST', body }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSending(false);
    }
  }

  if (result)
    return (
      <div className="card" style={{ maxWidth: 680 }}>
        <h1>Reporte registrado</h1>
        <div className="alert ok" role="status">
          Tu reporte quedó guardado de forma segura el {new Date(result.receivedAt).toLocaleString('es-PE')}.{result.duplicate && ' (Era un reintento: te mostramos el mismo ticket.)'}
        </div>
        <p>
          Ticket: <strong className="mono">{result.ticketId}</strong>
        </p>
        <p>
          <strong>Token privado de consulta</strong> — guárdalo; es la única forma de consultar tu ticket sin iniciar sesión y no lo volveremos a mostrar:
        </p>
        <div className="token" aria-label="Token de consulta">
          {result.token}
        </div>
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(result.token).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copiado ✓' : 'Copiar token'}
          </button>
          <Link className="btn primary" to="/ticket" state={{ token: result.token }}>
            Ver estado
          </Link>
          <button
            className="btn"
            onClick={() => {
              setResult(undefined);
              setIdemKey(newIdemKey());
              setForm({ ...form, description: '' });
            }}
          >
            Nuevo reporte
          </button>
        </div>
      </div>
    );

  if (catalog.loading) return <Loading />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={catalog.reload} />;
  const c = catalog.data!;

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>Reportar un problema de servicio</h1>
      <p className="secondary">Los campos marcados con * son obligatorios. Tu documento se usa solo para contar personas distintas (seudónimo irreversible) y nunca se muestra.</p>
      {error && !Object.keys(fieldErrors).length && (
        <div className="alert err" role="alert">
          {error.message}
        </div>
      )}
      <form className="card" onSubmit={submit} noValidate>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={sending}>
          <legend className="sr-only">Identificación</legend>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="dt">Tipo de documento *</label>
              <select id="dt" value={form.documentType} onChange={set('documentType')}>
                <option value="DNI">DNI</option>
                <option value="CE">Carné de extranjería</option>
                <option value="PASAPORTE">Pasaporte</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="dn">Número de documento *</label>
              <input id="dn" inputMode="numeric" autoComplete="off" required value={form.documentNumber} onChange={set('documentNumber')} aria-invalid={!!fieldErrors.documentNumber} />
              {fieldErrors.documentNumber && <div className="field-error">{fieldErrors.documentNumber}</div>}
            </div>
            <div className="field">
              <label htmlFor="sn">
                Número del servicio móvil * <span className="help">(9XX XXX XXX)</span>
              </label>
              <input id="sn" inputMode="tel" required value={form.serviceNumber} onChange={set('serviceNumber')} aria-invalid={!!fieldErrors.serviceNumber} />
              {fieldErrors.serviceNumber && <div className="field-error">{fieldErrors.serviceNumber}</div>}
            </div>
            <div className="field">
              <label htmlFor="zone">Zona *</label>
              <select id="zone" required value={form.zoneId} onChange={set('zoneId')} aria-invalid={!!fieldErrors.zoneId}>
                <option value="">Selecciona tu zona…</option>
                {c.zones.map((z) => (
                  <option key={z.zoneId} value={z.zoneId}>
                    {z.name}
                  </option>
                ))}
              </select>
              {fieldErrors.zoneId && <div className="field-error">{fieldErrors.zoneId}</div>}
            </div>
            <div className="field">
              <label htmlFor="loc">
                Referencia aproximada <span className="help">(opcional, sin dirección exacta)</span>
              </label>
              <input id="loc" maxLength={120} value={form.locationHint} onChange={set('locationHint')} placeholder="p. ej. cerca del mercado" />
            </div>
            <div className="field">
              <label htmlFor="when">Fecha y hora del problema *</label>
              <input id="when" type="datetime-local" required max={localNowInput()} value={form.occurredAt} onChange={set('occurredAt')} aria-invalid={!!fieldErrors.occurredAt} />
              {fieldErrors.occurredAt && <div className="field-error">{fieldErrors.occurredAt}</div>}
            </div>
            <div className="field">
              <label htmlFor="pt">Tipo de problema *</label>
              <select id="pt" value={form.problemType} onChange={set('problemType')}>
                {c.problemTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="desc">Descripción *</label>
            <textarea id="desc" required minLength={10} maxLength={1000} value={form.description} onChange={set('description')} aria-invalid={!!fieldErrors.description} placeholder="Cuéntanos qué ocurre (no incluyas datos personales)" />
            {fieldErrors.description && <div className="field-error">{fieldErrors.description}</div>}
          </div>
          <h3>Avisos (opcional)</h3>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="em">Correo electrónico</label>
              <input id="em" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
            </div>
            <div className="field">
              <label htmlFor="ph">Teléfono para SMS</label>
              <input id="ph" inputMode="tel" value={form.phone} onChange={set('phone')} />
            </div>
          </div>
          {fieldErrors.contact && <div className="field-error">{fieldErrors.contact}</div>}
          <label className="check">
            <input type="checkbox" checked={form.notifyConsent} onChange={set('notifyConsent')} /> Acepto recibir avisos sobre este reporte (evaluación, incidencia en mi zona y restablecimiento).
          </label>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn primary" type="submit">
              {sending ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Enviando…
                </>
              ) : (
                'Enviar reporte'
              )}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
