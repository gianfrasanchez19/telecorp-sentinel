import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div>
      <section className="hero">
        <h1>¿Problemas con tu señal móvil? Repórtalo y sigue su atención.</h1>
        <p className="secondary" style={{ maxWidth: 720 }}>
          TeleCorp Sentinel une los reportes de los usuarios con la telemetría de las antenas para detectar incidentes por zona, priorizarlos y avisarte cuando el servicio se
          restablezca. Tus datos personales se guardan cifrados y nunca se muestran a terceros.
        </p>
        <div className="row" style={{ marginTop: '1rem' }}>
          <Link className="btn primary" to="/reportar">
            Reportar un problema
          </Link>
          <Link className="btn" to="/ticket">
            Consultar mi ticket
          </Link>
        </div>
      </section>
      <div className="grid grid-3">
        <div className="card">
          <h3>1 · Reporta</h3>
          <p className="secondary">Indica tu zona, el tipo de problema y desde cuándo ocurre. Recibirás un ticket y un token privado de consulta.</p>
        </div>
        <div className="card">
          <h3>2 · Detectamos</h3>
          <p className="secondary">Si 10 o más personas distintas reportan problemas similares en tu zona en menos de 24 h, se abre un posible incidente colectivo.</p>
        </div>
        <div className="card">
          <h3>3 · Te avisamos</h3>
          <p className="secondary">Con tu consentimiento, te notificamos por correo cuando tu reporte se evalúa, si se confirma una incidencia y cuando se restablece el servicio.</p>
        </div>
      </div>
      <div className="card" style={{ marginTop: '1rem' }}>
        <h3>¿Eres operador de red?</h3>
        <p className="secondary">La consola de operaciones muestra antenas, incidentes priorizados, análisis con IA y analítica. Requiere autenticación.</p>
        <Link className="btn" to="/operador/login">
          Ir a la consola
        </Link>
      </div>
    </div>
  );
}
