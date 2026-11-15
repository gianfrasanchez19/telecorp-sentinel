# Matriz de verificación de la rúbrica (documento INTERNO — no garantiza calificación)

Rúbrica oficial, leída de la página del hackathon: problemas (3), persistencia y alta disponibilidad (2), Step Functions (2), dos nubes o más (3), arquitectura (3), pitch de 5 min (2), solución serverless (2) y uso de IA (3). Total: 20.

Reglas de entrega: video de 5 minutos como máximo; entregar video, repositorio de GitHub y arquitectura; **no entregar informe**; Vercel no cuenta como nube; usar un servicio de AWS para proteger las variables o secretos.

Estado de la evidencia:

- **L** = verificado en local (emulado), con pruebas automatizadas.
- **I** = IaC validada sin desplegar (cfn-lint).
- **C** = verificado en la nube. **Pendiente**: requiere tu autorización y credenciales.

| Criterio (pts) | Qué lo cumple | Código | Pruebas / evidencia | Estado |
|---|---|---|---|---|
| **Resolver problemas del contexto (3)** | Clasificación exacta de antenas (0, <60, 60–129, >129); rechazo de negativos y no finitos; SIN_DATOS ≠ 0. Reportes con ticket opaco y token con hash. Colectivo con ≥10 usuarios distintos en una ventana estrictamente menor de 24 h. Un único incidente por clave lógica. Recuperación tras 3 lecturas normales con verificación del operador. Prioridad explicable. Recurrencia (3 episodios en 7 días). Notificaciones deduplicadas. Analítica con MTTD/MTTR. Ráfagas | `backend/src/domain/*`, `services/*`, `workflow/steps.ts`, `frontend/` | `test/domain.test.ts` (22), `test/flow.test.ts` (16), `npm run demo` (12/12), `docs/evidence/load-local-*.json` (1000/1000, 0 fallos) | L ✅ · C pendiente |
| **Persistencia y alta disponibilidad (2)** | DynamoDB on-demand Multi-AZ con PITR, SSE, Streams, `DeletionPolicy: Retain` y TTL solo para datos temporales. TransactWrite + outbox; SQS con DLQ; reconciliador | `infra/aws/resources.yml`, `docs/data-model.md`, `services/pipeline.ts` | Pruebas de idempotencia, replay y ráfaga; cfn-lint | L ✅ · I ✅ · C pendiente |
| **Step Functions (2)** | Standard, con Choice ×3, Map, Retry exponencial con jitter y Catch → MarkFailed y Fail. El estado de fallo se persiste y hay replay específico | `backend/statemachine/incident-workflow.asl.json` (un solo archivo para AWS y local) | La misma ASL se ejecuta en el intérprete local; prueba de fallo controlado + replay; alarma `ExecutionsFailed` | L ✅ (emulado) · I ✅ · C pendiente (captura de la consola de Step Functions para el video) |
| **Dos nubes o más (3)** | AWS como núcleo + **Google Cloud**: Cloud Run privado + Vertex AI Gemini, autenticado con **Workload Identity Federation** (sin claves) | `ai-service/`, `infra/gcp/deploy-gcp.sh`, `backend/src/ai/gcpAuth.ts` | `ai-service/tests` (7), `test/ai-auth.test.ts` (4: forma del token WIF, ID token y contrato HMAC) | L ✅ · C pendiente (necesita proyecto GCP con facturación o créditos) |
| **Arquitectura (3)** | Diagrama con límites AWS/GCP, flujo, autenticación, persistencia, Step Functions, recuperación y notificaciones | `docs/architecture.svg`, `docs/architecture.png`, `docs/architecture.mmd` | Mermaid compilado; SVG y PNG revisados visualmente | ✅ |
| **Pitch de 5 min (2)** | Guion de 4:40 con tiempos | `docs/demo-script.md` | Ensayo pendiente (equipo) | Guion ✅ · video pendiente |
| **Solución serverless (2)** | Lambda, API Gateway, DynamoDB, SQS, Step Functions, EventBridge, Secrets Manager, S3 + CloudFront, SES y Cloud Run (min 0). Sin EC2 ni clústeres | `backend/serverless.yml` | cfn-lint sobre la plantilla ensamblada (47 recursos) | I ✅ · C pendiente |
| **Uso de IA (3)** | Gemini en Vertex AI en la apertura o ante cambios materiales. Contexto anonimizado; descripciones tratadas como datos no confiables. Salida JSON validada. Caché por hash. Respaldo `AI_UNAVAILABLE` etiquetado. La IA no decide nada | `ai-service/app/*`, `backend/src/ai/*`, `workflow/steps.ts` | Prueba "contexto IA sin PII"; respaldo con reintentos; validación de salida inválida (422) | L ✅ (con modelo simulado) · C pendiente (llamada real a Gemini) |

Reglas adicionales:

| Regla | Cumplimiento |
|---|---|
| Servicio de AWS para proteger secretos | **AWS Secrets Manager**: clave maestra generada por AWS (`GenerateSecretString`) y derivación HKDF. Nada sensible en git ni en el frontend |
| Vercel no cuenta | No se usa Vercel. El frontend va en S3 + CloudFront |
| No entregar informe | Los `docs/*.md` son notas internas del repositorio. En Canvas se entregan solo video, enlace a GitHub y arquitectura (PNG/SVG) |
| Video ≤ 5 min | El guion dura 4:40 |
