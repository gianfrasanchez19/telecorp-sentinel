# Matriz de cobertura del curso (documento INTERNO — no es un informe de entrega)

Fuentes revisadas (2026-11-15):

- **Canvas** CS2032 Cloud Computing, Teo. 3 / Lab. 373, ciclo 2026-2: estructura de módulos de las semanas 1 a 14 y tareas, leídas con la API de Canvas en la sesión del alumno.
- **Material local** del alumno (PDFs y ZIPs con el encabezado "Ciclo 2026-2"): talleres de las semanas 1 a 14.
- **Convocatoria del hackathon:** se leyeron la rúbrica y las reglas públicas. El texto del reto requiere iniciar sesión con correo y contraseña institucionales y no se leyó.

Marcas: ✅ verificado · ⚠️ no verificable (no se pudo abrir) · ➕ requisito del hackathon o del enunciado que no se ve en las semanas disponibles.

| Semana | Fuente | Concepto | Servicio / técnica usada | Dónde se implementa |
|---|---|---|---|---|
| 1–2 | Virtualización (talleres 1–4 y teoría) ✅ | EC2 / máquinas virtuales | **No se usa a propósito**: la rúbrica exige una solución 100 % serverless | — |
| 3–4 | Contenedores (teoría 1–2 y talleres 1–4) ✅ | Docker | Imagen del microservicio de IA, que Cloud Run construye desde el Dockerfile | `ai-service/Dockerfile` |
| 5 | Almacenamiento (teoría 1, taller S3) ✅ | S3 | S3 privado para el frontend, servido por CloudFront con OAC | `infra/aws/resources.yml` |
| 5 | API REST + base de datos + web ✅ | REST, CORS | API HTTP con CORS restringido y SPA en React | `backend/src/handlers/api`, `frontend/` |
| 6 | Escalabilidad, elasticidad, balanceo y alta disponibilidad ✅ | Elasticidad y HA | Servicios gestionados Multi-AZ, escalado a cero y throttling | `backend/serverless.yml`, README |
| 7 | Bases de datos (teoría 2) y migración (6R) ✅ | NoSQL | DynamoDB con tabla única, diseñada por patrones de acceso | `backend/src/repo/keys.ts`, `docs/data-model.md` |
| 7 | Automatizaciones (shell) ✅ | Scripts bash | Despliegue, limpieza y validación automatizados | `scripts/`, `infra/gcp/` |
| 9 | Multi-tenancy, NoSQL y DynamoDB Book ✅ | PK, SK y GSI | `pk`/`sk`, GSI1 y GSI2, partición por zona y familia | `backend/src/repo/keys.ts` |
| 10 | Serverless taller 1 "Sistema de Seguridad" ✅. El taller indica que **Cognito no está disponible en AWS Academy** | Token con expiración | Usuarios en DynamoDB + JWT firmado + Lambda Authorizer | `backend/src/services/auth.ts` |
| 10 | Serverless taller 2: Serverless Framework ✅ | `serverless deploy`, `org`, **LabRole** | IaC con Serverless Framework v4 y `iam.role = LabRole` | `backend/serverless.yml` |
| 11 | Optimización de Lambdas y stages ✅ | Memoria, `--stage`, curl | Memoria y timeout por función, stages, smoke test | `backend/serverless.yml`, `scripts/smoke-test.ts` |
| 11 | UUID, variables de entorno y recursos por stage ✅ | Variables de entorno, `serverless remove` | Tabla `telecorp-sentinel-<stage>` y script de limpieza | `infra/aws/resources.yml`, `scripts/cleanup-aws.sh` |
| 12 | CloudWatch y Logs Insights. La tarea pide el formato `{tipo, log_datos}` ✅ | Logs JSON estándar | Logger `{tipo, log_datos}` sin PII; alarmas | `backend/src/lib/logger.ts`, `ai-service/app/main.py` |
| 12 | Cloud observability (teoría 1b) ⚠️ | Observabilidad | X-Ray, métricas y alarmas | `serverless.yml`, `resources.yml` |
| 13 | SNS y arquitectura orientada a eventos ✅ | Publicar/suscribir | Tema SNS de alertas y SMS opcional; SES para correo ciudadano | `resources.yml`, `backend/src/aws/cloudRuntime.ts` |
| 14 | SQS y DLQ (taller 3) ✅ | Colas y DLQ | Colas de eventos y de notificaciones, cada una con DLQ | `resources.yml` |
| 14 | SNS + SQS + EventBridge con sensor IoT cada minuto (taller 4) ✅ | Simulador programado | Telemetría sintética cada minuto con una regla de EventBridge | `backend/src/services/simulator.ts` |
| 14 | "Otros tópicos" y Well-Architected Serverless ⚠️ | Buenas prácticas | Mínimo privilegio, idempotencia, DLQ y alarmas | README |
| 15 | Proyecto Final V5.00 ⚠️ | — | No se pudo abrir: la vista previa del archivo estaba bloqueada | — |
| — | Rúbrica del hackathon ➕ | Step Functions, 2 nubes, IA, secretos en AWS | Step Functions Standard, Cloud Run + Vertex AI, Secrets Manager | `backend/statemachine/`, `ai-service/`, `infra/gcp/` |

## Restricciones de AWS Academy

| Restricción | Fuente | Decisión |
|---|---|---|
| No se pueden crear roles IAM; hay que usar **LabRole** | `serverless.yml` del curso (S10–S12) ✅ | Parámetro `labRoleArn` para Lambda, Step Functions y Scheduler. Para cuentas normales se incluye el rol de mínimo privilegio `infra/aws/iam-roles.yml` |
| Cognito no disponible | Taller S10-1 ✅ | JWT propio con clave en Secrets Manager |
| Las credenciales del laboratorio duran 4 h | Taller S10-2 ✅ | `deploy-aws.sh` verifica la identidad antes de desplegar; la autenticación AWS→GCP usa el rol, no credenciales de usuario |
| Región us-east-1 | Ejemplos del curso ✅ | Región por defecto `us-east-1` |
| CloudFront, X-Ray y SES | **Verificado en la cuenta (2026-11-15) con `scripts/check-aws-services.sh`: `AccessDenied`** | Frontend en **sitio web S3** (taller S5), `tracing=false` y correo por **SNS** con suscripción y política de filtro (taller S13). La IaC con CloudFront, X-Ray y SES se conserva para cuentas normales |
| EventBridge Scheduler, Lambda, API Gateway v2, DynamoDB, SQS, Step Functions, Secrets Manager, CloudFormation, S3, SNS, CloudWatch | ✅ Verificado en la cuenta | Se usan. LabRole confía en `lambda`, `states` y `scheduler`. Concurrencia de Lambda de la cuenta: 1000 |
