import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type Session } from '../api';
import { useAuth } from '../App';

export default function LoginPage() {
  const { session, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  if (session) return <Navigate to="/operador" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      const s = await api<Session>('/auth/login', { method: 'POST', body: { username, password } });
      login(s);
      nav(loc.state?.from ?? '/operador', { replace: true });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '2rem auto' }}>
      <h1>Consola de operaciones</h1>
      <p className="secondary">Acceso restringido a operadores. La sesión expira en 1 hora.</p>
      {error && (
        <div className="alert err" role="alert">
          {error.message}
        </div>
      )}
      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="u">Usuario</label>
          <input id="u" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="p">Contraseña</label>
          <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn primary" disabled={loading}>
          {loading ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
