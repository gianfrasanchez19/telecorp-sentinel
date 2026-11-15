import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, fmtDate } from '../api';
import { CaseBadge, caseLabel, ErrorState } from '../components/ui';

interface TicketView {
  ticketId: string;
  status: string;
  zone: { zoneId: string; name: string };
  problemLabel: string;
  occurredAt: string;
  receivedAt: string;
  notifications: { consent: boolean; email?: string; phone?: string };
  history: { at: string; type: string; fromStatus?: string; toStatus?: string; reason?: string; actor: string }[];
  incidents: { incidentId: string; kind: string; status: string; title: string; openedAt: string }[];
}

export default function TicketPage() {
  const loc = useLocation() as { state?: { token?: string } };
  const [token, setToken] = useState(loc.state?.token ?? '');
  const [data, setData] = useState<TicketView>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);

  async function lookup(e?: FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      // El token viaja en el CUERPO (POST), nunca en la URL ni en registros.
      setData(await api<TicketView>('/reports/lookup', { method: 'POST', body: { token: token.trim() } }));
    } catch (err) {
      setData(undefined);
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (loc.state?.token) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>Consultar mi ticket</h1>
      <form className="card" onSubmit={lookup}>
        <div className="field">
          <label htmlFor="tk">Token privado de consulta</label>
          <input id="tk" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} required minLength={32} />
        </div>
        <button className="btn primary" disabled={loading || token.trim().length < 32}>
          {loading ? 'Consultando…' : 'Consultar'}
        </button>
      </form>
      {error && <ErrorState error={error} />}
      {data && (
        <div className="card">
          <div className="page-head">
            <div>
              <h2 className="mono">{data.ticketId}</h2>
              <div className="secondary">
                {data.problemLabel} · {data.zone.name}
              </div>
            </div>
            <CaseBadge status={data.status} />
          </div>
          <p>
            Problema desde: <strong>{fmtDate(data.occurredAt)}</strong> · Recibido: <strong>{fmtDate(data.receivedAt)}</strong>
          </p>
          <p className="secondary">
            Avisos: {data.notifications.consent ? `activados (${[data.notifications.email, data.notifications.phone].filter(Boolean).join(', ')})` : 'no solicitados'}
          </p>
          {data.incidents.length > 0 && (
            <div className="alert warn">
              {data.incidents.map((i) => (
                <div key={i.incidentId}>
                  Tu reporte está asociado a un {i.kind === 'COLECTIVO' ? 'posible incidente colectivo' : 'incidente de infraestructura'} en tu zona — estado: <strong>{caseLabel(i.status)}</strong>.
                </div>
              ))}
            </div>
          )}
          <h3>Historial</h3>
          <ol className="timeline">
            {data.history.map((h, k) => (
              <li key={k}>
                <div className="when">{fmtDate(h.at)}</div>
                <div>
                  {h.toStatus ? (
                    <>
                      {h.fromStatus ? `${caseLabel(h.fromStatus)} → ` : ''}
                      <strong>{caseLabel(h.toStatus)}</strong>
                    </>
                  ) : (
                    h.type
                  )}
                </div>
                {h.reason && <small>{h.reason}</small>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
