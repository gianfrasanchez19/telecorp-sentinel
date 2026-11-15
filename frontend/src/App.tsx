import { createContext, useContext, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { getSession, setSession, type Session } from './api';
import { useApi } from './hooks';
import type { Health } from './types';
import Home from './pages/Home';
import ReportPage from './pages/ReportPage';
import TicketPage from './pages/TicketPage';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import AntennasPage from './pages/AntennasPage';
import ReportsPage from './pages/ReportsPage';
import IncidentsPage from './pages/IncidentsPage';
import IncidentDetailPage from './pages/IncidentDetailPage';
import AnalyticsPage from './pages/AnalyticsPage';
import SimulatorPage from './pages/SimulatorPage';

interface AuthCtx {
  session: Session | null;
  login: (s: Session) => void;
  logout: () => void;
}
const Auth = createContext<AuthCtx>({ session: null, login: () => undefined, logout: () => undefined });
export const useAuth = () => useContext(Auth);

function RequireOperator({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const loc = useLocation();
  if (!session) return <Navigate to="/operador/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function Layout({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const health = useApi<Health>('/health');
  const local = health.data?.mode === 'local';
  return (
    <>
      <a className="skip" href="#contenido">
        Saltar al contenido
      </a>
      <div className="banner" role="note">
        Proyecto académico con <strong>datos sintéticos</strong> (zonas, antenas y coberturas ficticias). No representa a ningún operador real.
        {local && <> · <strong>MODO LOCAL EMULADO</strong>: colas, Step Functions y correo emulados; no equivale a la nube.</>}
        {health.error && <> · API no disponible.</>}
      </div>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <img src="/favicon.svg" alt="" />
            TeleCorp Sentinel
          </NavLink>
          <nav className="nav" aria-label="Principal">
            <NavLink to="/" end>
              Inicio
            </NavLink>
            <NavLink to="/reportar">Reportar problema</NavLink>
            <NavLink to="/ticket">Consultar ticket</NavLink>
            <span className="sep" aria-hidden="true" />
            {session ? (
              <>
                <NavLink to="/operador">Panel</NavLink>
                <NavLink to="/operador/incidentes">Incidentes</NavLink>
                <NavLink to="/operador/antenas">Antenas</NavLink>
                <NavLink to="/operador/reportes">Reportes</NavLink>
                <NavLink to="/operador/analitica">Analítica</NavLink>
                <NavLink to="/operador/simulacion">Laboratorio</NavLink>
              </>
            ) : (
              <NavLink to="/operador/login">Acceso operador</NavLink>
            )}
          </nav>
          {session && (
            <div className="row">
              <small>{session.user.displayName}</small>
              <button className="btn sm" onClick={logout}>
                Salir
              </button>
            </div>
          )}
        </div>
      </header>
      <main id="contenido">{children}</main>
      <footer>
        TeleCorp Sentinel · Hackathon Cloud Computing UTEC 2026-2 · Grupo 60 · Núcleo AWS serverless + IA en Google Cloud.
        {health.data && (
          <>
            {' '}
            · Backend: {health.data.mode === 'aws' ? 'AWS' : 'local emulado'} · IA: {health.data.ai}
          </>
        )}
      </footer>
    </>
  );
}

export default function App() {
  const [session, setS] = useState<Session | null>(() => getSession());
  const auth: AuthCtx = {
    session,
    login: (s) => {
      setSession(s);
      setS(s);
    },
    logout: () => {
      setSession(null);
      setS(null);
    },
  };
  return (
    <Auth.Provider value={auth}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/reportar" element={<ReportPage />} />
            <Route path="/ticket" element={<TicketPage />} />
            <Route path="/operador/login" element={<LoginPage />} />
            <Route path="/operador" element={<RequireOperator><Dashboard /></RequireOperator>} />
            <Route path="/operador/incidentes" element={<RequireOperator><IncidentsPage /></RequireOperator>} />
            <Route path="/operador/incidentes/:id" element={<RequireOperator><IncidentDetailPage /></RequireOperator>} />
            <Route path="/operador/antenas" element={<RequireOperator><AntennasPage /></RequireOperator>} />
            <Route path="/operador/reportes" element={<RequireOperator><ReportsPage /></RequireOperator>} />
            <Route path="/operador/analitica" element={<RequireOperator><AnalyticsPage /></RequireOperator>} />
            <Route path="/operador/simulacion" element={<RequireOperator><SimulatorPage /></RequireOperator>} />
            <Route path="*" element={<div className="state">Página no encontrada.</div>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </Auth.Provider>
  );
}
