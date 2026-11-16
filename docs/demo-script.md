# Guion del pitch — 4:40 (INTERNO; el video nunca debe pasar de 5:00)

Antes de grabar:

- `ASSUME_YES` **no**. Encender el simulador (`SIMULATOR_ENABLED=true`) solo durante la grabación.
- Iniciar sesión en la consola con el operador.
- Tener abiertas: la consola de Step Functions (ejecuciones), CloudWatch y la consola de Cloud Run y Vertex AI.
- **Si un servicio no está desplegado, decirlo en el video. No mostrar capturas que no sean reales.**

| Tiempo | Bloque | Qué mostrar | Qué decir (resumen) |
|---|---|---|---|
| 0:00–0:30 | El dolor | Portada del portal | Hoy un corte de señal en un hospital se detecta tarde: los reclamos llegan por canales dispersos y nadie los cruza con la telemetría de las antenas. |
| 0:30–1:05 | Portal y reporte | `/reportar` → enviar → ticket + token → `/ticket` | Formulario validado, datos personales cifrados y nunca expuestos. El ticket es opaco y el token se guarda solo como hash. Escritura durable e idempotente. |
| 1:05–1:55 | 9 + 1 usuarios y antena | Laboratorio: 9 usuarios + 1 repetido → sin colectivo. Décimo usuario distinto → colectivo con "investigación pendiente". Luego "antena inhabilitada" en Santa Rosa Norte → incidente de infraestructura relacionado | La regla exacta: 10 personas distintas en menos de 24 h, sin contar tickets repetidos. Una sola incidencia por antena desde la primera lectura anómala, no una por minuto. |
| 1:55–2:35 | Step Functions real y priorización | Consola de AWS Step Functions: grafo de una ejecución (Choice, Map, Retry, Catch). Detalle del incidente: puntaje y factores | Cada reporte pasa por outbox → SQS → Step Functions Standard, con nombre determinista. La prioridad es determinista y explicable: hospital > residencial. |
| 2:35–3:15 | IA en GCP y notificación | Detalle: análisis "Google Vertex AI · \<modelo\>". Cloud Run (privado) en la consola GCP. Cambiar a SOLUCIONADA → notificación "aceptada por el proveedor" | AWS invoca Cloud Run sin claves, con Workload Identity Federation. Gemini recibe solo datos anonimizados y sugiere; no decide. Si falla, hay respaldo etiquetado. Correo vía Amazon SNS, con un tema filtrado por destinatario (AWS Academy bloquea SES). |
| 3:15–3:55 | Dashboard y recurrencia | Panel, Antenas (mapa esquemático y episodios), Analítica (MTTD/MTTR, reportantes vs. estimados) | Recurrencia de 3 episodios en 7 días ⇒ revisión estructural. Métricas calculadas sobre datos persistidos. |
| 3:55–4:25 | Arquitectura, HA, seguridad, serverless | `docs/architecture.png` | 100 % serverless. DynamoDB Multi-AZ con PITR. DLQ, idempotencia, Secrets Manager, JWT y CORS. Dos nubes reales. Probado con 1000 reportes simultáneos (medido en local; mostrar la cifra de la nube solo si se midió allí). |
| 4:25–4:40 | Cierre | Logo | TeleCorp Sentinel convierte reclamos dispersos en incidentes priorizados y comunicados. Grupo 60. |

Plan B, si la nube no está lista: grabar en modo local, con el banner "MODO LOCAL EMULADO" visible, y **decirlo explícitamente**.
