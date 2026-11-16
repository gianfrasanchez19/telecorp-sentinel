# Matriz de verificación de la rúbrica (documento INTERNO — no garantiza calificación)

Rúbrica oficial, leída de la página del hackathon: problemas (3), persistencia y alta disponibilidad (2), Step Functions (2), dos nubes o más (3), arquitectura (3), pitch de 5 min (2), solución serverless (2) y uso de IA (3). Total: 20.

Reglas de entrega: video de 5 minutos como máximo; entregar video, repositorio de GitHub y arquitectura; **no entregar informe**; Vercel no cuenta como nube; usar un servicio de AWS para proteger las variables o secretos.

Estado de la evidencia:

- **L** = verificado en local (emulado), con pruebas automatizadas.
- **I** = IaC validada sin desplegar (cfn-lint).
- **C** = verificado en la nube real (AWS Academy, us-east-1, 2026-11-15). Evidencias: `docs/evidence/e2e-cloud-*.json` (multinube 12/12 con Gemini real) y `docs/evidence/load-cloud-*.json` (200/200).

| Criterio (pts) | Qué lo cumple | Código | Pruebas / evidencia | Estado |
|---|---|---|---|---|
| **Resolver problemas del contexto (3)** | Clasificación exacta de antenas (0, <60, 60–129, >129); rechazo de negativos y no finitos; SIN_DATOS ≠ 0. Reportes con ticket opaco y token con hash. Colectivo con ≥10 usuarios distintos en una ventana estrictamente menor de 24 h. Un único incidente por clave lógica. Recuperación tras 3 lecturas normales con verificación del operador. Prioridad explicable. Recurrencia (3 episodios en 7 días). Notificaciones deduplicadas. Analítica con MTTD/MTTR. Ráfagas | `backend/src/domain/*`, `services/*`, `workflow/steps.ts`, `frontend/` | `test/domain.test.ts` (24), `test/flow.test.ts` (16), `npm run demo` (12/12), carga local 1000/1000, **E2E multinube 12/12**, **carga en la nube 200/200** (0 fallos) | L ✅ · C ✅ |
| **Persistencia y alta disponibilidad (2)** | DynamoDB on-demand Multi-AZ con PITR, SSE, Streams, `DeletionPolicy: Retain` y TTL solo para datos temporales. TransactWrite + outbox; SQS con DLQ; reconciliador | `infra/aws/resources.yml`, `docs/data-model.md`, `services/pipeline.ts` | Pruebas de idempotencia, replay y ráfaga; cfn-lint; **verificado en AWS**: tabla ACTIVE on-demand, SSE, Streams, PITR y TTL activos | L ✅ · I ✅ · C ✅ |
| **Step Functions (2)** | Standard, con Choice ×3, Map, Retry exponencial con jitter y Catch → MarkFailed y Fail. El estado de fallo se persiste y hay replay específico | `backend/statemachine/incident-workflow.asl.json` (un solo archivo para AWS y local) | La misma ASL se ejecuta en el intérprete local; prueba de fallo controlado + replay; alarma `ExecutionsFailed` | L ✅ · I ✅ · **C ✅**: `validate-state-machine-definition` = OK; más de 250 ejecuciones reales SUCCEEDED y 0 FALLIDO (E2E + carga) |
| **Dos nubes o más (3)** | AWS como núcleo + **Google Cloud**: Cloud Run privado + Vertex AI Gemini, autenticado con **Workload Identity Federation** (sin claves) | `ai-service/`, `infra/gcp/deploy-gcp.sh`, `backend/src/ai/gcpAuth.ts` | `ai-service/tests` (7), `test/ai-auth.test.ts` (4: forma del token WIF, ID token y contrato HMAC) | L ✅ · **C ✅**: Cloud Run privado en GCP invocado desde AWS Step Functions mediante WIF; E2E multinube 12/12 |
| **Arquitectura (3)** | Diagrama con límites AWS/GCP, flujo, autenticación, persistencia, Step Functions, recuperación y notificaciones | `docs/architecture.svg`, `docs/architecture.png`, `docs/architecture.mmd` | Mermaid compilado; SVG y PNG revisados visualmente | ✅ |
| **Pitch de 5 min (2)** | Guion de 4:40 con tiempos | `docs/demo-script.md` | Ensayo pendiente (equipo) | Guion ✅ · video pendiente |
| **Solución serverless (2)** | Lambda (incluido el portal `webApp`), API Gateway, DynamoDB, SQS, Step Functions, EventBridge, Secrets Manager, SNS y Cloud Run (min 0). Sin EC2 ni clústeres. CloudFront, SES y X-Ray están bloqueados en Academy; la IaC alternativa se conserva | `backend/serverless.yml` | cfn-lint sobre la plantilla ensamblada (47 recursos) | I ✅ · **C ✅** (stack de 95 recursos desplegado, sin EC2) |
| **Uso de IA (3)** | Gemini en Vertex AI en la apertura o ante cambios materiales. Contexto anonimizado; descripciones tratadas como datos no confiables. Salida JSON validada. Caché por hash. Respaldo `AI_UNAVAILABLE` etiquetado. La IA no decide nada | `ai-service/app/*`, `backend/src/ai/*`, `workflow/steps.ts` | Prueba "contexto IA sin PII"; respaldo con reintentos; validación de salida inválida (422) | L ✅ · **C ✅**: `gemini-3.5-flash-lite` real (~1,4–1,8 s, ~815/275 tokens); ignoró una inyección de prompt; salida validada; respaldo probado |

Reglas adicionales:

| Regla | Cumplimiento |
|---|---|
| Servicio de AWS para proteger secretos | **AWS Secrets Manager**: clave maestra generada por AWS (`GenerateSecretString`) y derivación HKDF. Nada sensible en git ni en el frontend |
| Vercel no cuenta | No se usa Vercel. El portal se sirve por HTTPS desde AWS (API Gateway + Lambda) |
| No entregar informe | Los `docs/*.md` son notas internas del repositorio. En Canvas se entregan solo video, enlace a GitHub y arquitectura (PNG/SVG) |
| Video ≤ 5 min | El guion dura 4:40 |

## Resumen de puntos (autoevaluación interna; la nota la pone el jurado)

| Criterio | Pts | Evidencia clave |
|---|---|---|
| Problemas del contexto | 3 | 9+1 usuarios, colectivo, antenas, recuperación, prioridad, recurrencia, notificaciones y analítica; E2E en la nube |
| Persistencia y HA | 2 | DynamoDB Multi-AZ + PITR + outbox + DLQ; carga 200/200 |
| Step Functions | 2 | Standard con Choice, Map, Retry y Catch; ejecuciones reales sin fallos |
| Dos nubes | 3 | AWS + Google Cloud (Cloud Run + Vertex AI) integrados con WIF |
| Arquitectura | 3 | `docs/architecture.png` |
| Pitch | 2 | `docs/demo-script.md` (4:40); **falta grabarlo** |
| Serverless | 2 | Sin EC2 ni clústeres; todo escala a cero salvo el almacenamiento |
| IA | 3 | Gemini real con salida validada, anonimización y respaldo |
