# Guion del video — TeleCorp Sentinel (4:40; NUNCA pasar de 5:00)

Documento interno de apoyo para grabar; **no se entrega como informe**. Los clics exactos están en `docs/guia-demo.md` y los datos en `docs/datos-ficticios.md`.

## Quién prepara qué

| Antes de grabar | Responsable |
|---|---|
| Portal del redespliegue (2026-11-16): https://e8iarrhhf8.execute-api.us-east-1.amazonaws.com/ · operador `operador.demo` | Dueño de la cuenta AWS Academy |
| Grabar el clip de Step Functions (~20 s) en la consola de AWS Academy | Dueño de la cuenta AWS Academy |
| Grabar el clip de Cloud Run (~15 s) o dar acceso de solo lectura | Dueño del proyecto de Google Cloud |
| Confirmar que la sesión de AWS Academy esté iniciada durante la grabación | Dueño de la cuenta AWS Academy |
| Calentar las pantallas, emitir un minuto de telemetría y elegir una opción de datos | Quien graba |

## Guion (≈ 4:40)

| Tiempo | Bloque | En pantalla | Qué decir |
|---|---|---|---|
| **0:00–0:30** | El dolor | Inicio del portal (con el banner de datos sintéticos visible) | "Cuando cae una antena cerca de un hospital, los reclamos llegan dispersos y nadie los cruza con la telemetría. TeleCorp Sentinel une ambas fuentes, detecta incidentes por zona, los prioriza y avisa a los usuarios." |
| **0:30–1:05** | Portal y reporte | Reportar → formulario (ciudadano ficticio 1) → ticket + token → Ver estado: *Registrada → En revisión* | "El portal funciona sobre HTTPS con una política de seguridad estricta. El reporte se guarda de forma durable e idempotente; los datos personales se cifran y el token solo se guarda como hash. Ya pasó a *En revisión* porque lo evaluó el flujo en la nube." |
| **1:05–1:55** | Regla 9 + 1 y antena | Laboratorio: 9 personas + 1 repetida → Incidentes: nada. Una persona más → "Posible incidente colectivo" con *investigación pendiente*. "Antena inhabilitada" en la misma zona → incidente de infraestructura relacionado | "Nueve personas, una repetida: no hay colectivo. La décima persona distinta en menos de 24 h lo abre, aunque las antenas estén normales, y lo marca como investigación pendiente. Al caer una antena se abre un único incidente desde la primera lectura anómala, relacionado sin duplicar usuarios." |
| **1:55–2:35** | Step Functions y prioridad | **Clip 1** (grafo de Step Functions). Luego, en el detalle del incidente, "Prioridad explicada" | "Cada evento viaja por outbox, DynamoDB Streams y SQS hasta Step Functions Standard, con un nombre determinista: sin duplicados, con reintentos y con replay si algo falla. La prioridad es determinista y explicable: un hospital o un servicio crítico pesa más que una zona residencial." |
| **2:35–3:15** | IA en Google Cloud | Tarjeta "Google Vertex AI · gemini-3.5-flash-lite" (resumen, causas, acciones, incertidumbres). **Clip 2** (Cloud Run privado, escala a 0) | "Esta es la segunda nube. AWS invoca un Cloud Run privado sin claves, con Workload Identity Federation limitada a nuestro rol. Gemini recibe solo datos anonimizados, trata los textos de los usuarios como no confiables y sugiere, pero no decide. Si falla, hay un respaldo etiquetado." |
| **3:15–3:55** | Operación y analítica | Cambiar a *En atención* y *Solucionada* con motivo → cronología. Antenas → ANT-CSU-02 (3 episodios, revisión estructural). Analítica: MTTD/MTTR, reportantes únicos frente a usuarios estimados | "Cada cambio de estado queda auditado y la recuperación técnica exige verificación del operador. Tres episodios en siete días piden revisión estructural. Las métricas se calculan sobre datos persistidos." |
| **3:55–4:25** | Arquitectura y calidad | `arquitectura.png` | "Es 100 % serverless: Lambda, API Gateway, DynamoDB Multi-AZ con PITR, SQS con colas de error, Step Functions y EventBridge. Los secretos están en Secrets Manager; Cloud Run y Vertex AI corren en Google Cloud. Lo probamos en la nube real: 200 reportes simultáneos sin pérdidas y pruebas multinube de punta a punta." |
| **4:25–4:40** | Cierre | Inicio | "TeleCorp Sentinel convierte reclamos dispersos en incidentes priorizados, explicados y comunicados. Grupo 60." |

## Reglas
- Ensaya con cronómetro. El objetivo es 4:40 y el límite duro, 5:00: **un video más largo no se revisa**.
- Si algo no responde en vivo, dilo y continúa; **nunca simules resultados**.
- Usa solo datos ficticios y no muestres credenciales, IDs de cuenta ni archivos `.local`.
- En Canvas se entregan solo: **video, enlace de GitHub y arquitectura** (PNG). **No se entrega un informe.**
