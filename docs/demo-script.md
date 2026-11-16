# Guion del video — TeleCorp Sentinel (4:40; NUNCA pasar de 5:00)

Documento interno de apoyo para grabar. No se entrega como informe.

## Preparación (antes de grabar, unos 10 minutos)

1. **Credenciales AWS Academy vigentes:** iniciar el Learner Lab (duran 4 h).
2. **Encender el simulador solo durante la grabación:**
   ```bash
   SIMULATOR_ENABLED=true bash scripts/deploy-aws.sh
   ```
   La configuración de GCP se reutiliza desde `.local/deploy-dev.env`. Al terminar, volver a desplegar con `SIMULATOR_ENABLED=false`.
3. **Pestañas abiertas en el navegador** (resolución 1920×1080, zoom 110 %):
   1. Portal HTTPS (`<HttpApiUrl>/`, sección Inicio).
   2. Consola de operador ya logueada. Las credenciales están en `.local/aws-operator-credentials.txt`; **nunca mostrar ese archivo**.
   3. Consola AWS → Step Functions → `telecorp-sentinel-dev-incident-workflow` → Ejecuciones.
   4. Consola GCP → Cloud Run → `telecorp-ai` (pestaña Seguridad: "Requiere autenticación").
   5. `docs/architecture.png`.
4. **Datos ficticios preparados en el Laboratorio:** zona "Campus Sur" o "Miramar", tipo "SMS no llegan" (familia limpia). Usar un **índice inicial nuevo** (p. ej. 900): con el mismo índice se reutilizan las mismas personas ficticias y no suman.
5. **No mostrar en pantalla:** IDs de cuenta, correos, contraseñas, la terminal con credenciales ni `.local/`.

## Guion

| Tiempo | Bloque | En pantalla | Qué decir |
|---|---|---|---|
| **0:00–0:30** | El dolor | Inicio del portal | "Cuando cae una antena cerca de un hospital, los reclamos llegan dispersos y nadie los cruza con la telemetría. TeleCorp Sentinel une ambas fuentes, detecta incidentes por zona, los prioriza y avisa a los usuarios." |
| **0:30–1:05** | Portal y reporte | Reportar → formulario (DNI y número ficticios) → ticket + token → Consultar ticket → "En revisión" | "El portal va por HTTPS con política de seguridad estricta. El reporte se guarda de forma durable e idempotente; los datos personales se cifran y el token solo se guarda como hash. El estado ya pasó a *En revisión* porque lo evaluó el flujo en la nube." |
| **1:05–1:55** | Regla 9 + 1 y antena | Laboratorio: "Reportes de usuarios distintos" con 9 usuarios y repetir el #3 → Incidentes: ninguno. Luego 1 usuario más → aparece "Posible incidente colectivo" con *investigación pendiente*. Luego "Antena inhabilitada" en la misma zona → incidente de infraestructura relacionado | "Nueve personas, una repetida: no hay colectivo. La décima persona distinta en menos de 24 h lo abre, aunque las antenas estén normales, y lo marca como investigación pendiente. Al caer una antena, se abre un único incidente desde la primera lectura anómala, relacionado sin duplicar usuarios." |
| **1:55–2:35** | Step Functions real y prioridad | Consola de Step Functions: grafo de una ejecución SUCCEEDED (Choice, Map, Retry, Catch). Volver al detalle del incidente: puntaje y factores | "Cada evento viaja por outbox, DynamoDB Streams y SQS hasta Step Functions Standard, con nombre determinista: sin duplicados y con replay si algo falla. La prioridad es determinista y explicable; un hospital pesa más que una zona residencial." |
| **2:35–3:15** | IA en Google Cloud | Detalle del incidente → "Google Vertex AI · gemini-3.5-flash-lite": resumen, causas, acciones, incertidumbres. Consola GCP Cloud Run: privado, escala a 0 | "Esta es la segunda nube. AWS invoca un Cloud Run **privado** sin claves, con Workload Identity Federation limitada a nuestro rol. Gemini recibe solo datos anonimizados, trata los textos de usuarios como no confiables y sugiere, pero no decide. Si falla, hay un respaldo etiquetado." |
| **3:15–3:55** | Operación y analítica | Cambiar el estado a "En atención" y luego "Solucionada" con motivo → cronología. Antenas: mapa, episodios y recurrencia. Analítica: MTTD/MTTR, reportantes únicos frente a usuarios estimados | "Cada cambio de estado queda auditado y la recuperación técnica exige verificación del operador. Detectamos recurrencia: tres episodios en siete días piden revisión estructural. Las métricas se calculan sobre datos persistidos." |
| **3:55–4:25** | Arquitectura y calidad | `docs/architecture.png` | "Es 100 % serverless: Lambda, API Gateway, DynamoDB Multi-AZ con PITR, SQS con DLQ, Step Functions y EventBridge. Los secretos están en Secrets Manager; Cloud Run y Vertex AI corren en Google Cloud. Lo probamos en la nube: 200 reportes simultáneos sin pérdidas y pruebas multinube de punta a punta." |
| **4:25–4:40** | Cierre | Logo e Inicio | "TeleCorp Sentinel convierte reclamos dispersos en incidentes priorizados, explicados y comunicados. Grupo 60." |

## Reglas

- Ensayar con cronómetro y dejar margen: el objetivo es 4:40.
- Si algo no responde en vivo, decirlo y mostrar la evidencia guardada (`docs/evidence/`). **Nunca simular resultados.**
- Datos 100 % ficticios. No mostrar PII real ni credenciales.
- Al terminar: `SIMULATOR_ENABLED=false bash scripts/deploy-aws.sh` y revisar los costos.
