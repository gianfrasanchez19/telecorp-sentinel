# Modelo de datos — DynamoDB (tabla única)

Tabla `telecorp-sentinel-<stage>`: on-demand, cifrada (SSE), PITR, Streams `NEW_AND_OLD_IMAGES` y TTL sobre el atributo `ttl`.
Índices: **GSI1** (`gsi1pk`/`gsi1sk`) y **GSI2** (`gsi2pk`/`gsi2sk`), ambos con proyección ALL. Todas las fechas son ISO-8601 UTC, que ordenan lexicográficamente.
Fuente de verdad del diseño de claves: `backend/src/repo/keys.ts`.

## Entidades y claves

| Entidad | pk | sk | GSI | Notas |
|---|---|---|---|---|
| Zona, Antena, Celda | — | — | — | Catálogo fijo sintético en código (`domain/catalog.ts`) |
| Reporte (vista pública) | `RPT#<ticketId>` | `META` | GSI2 `RPTDAY#<yyyy-mm-dd>` / `<receivedAt>#<ticket>` | Sin PII; descripción redactada; `userHash` = HMAC |
| PII del reporte | `RPT#<ticketId>` | `PII` | — | Teléfono, correo, descripción original y referencia de ubicación **cifrados con AES-256-GCM** |
| Historial del reporte | `RPT#<ticketId>` | `HIST#<at>#<suf>` | — | Solo se agrega; nunca se sobrescribe |
| Punto de correlación | `ZF#<zone>#<family>` | `<occurredAt>#<ticket>` | — | **Partición base, lectura consistente**, para la ventana de menos de 24 h |
| Hash del token de consulta | `TOK#<sha256(token)>` | `TOK` | — | El token en claro nunca se guarda |
| Idempotencia de reporte | `IDEM#<sha256(key)>` | `IDEM` | — | TTL de 30 días; el token se re-deriva con HMAC |
| Métrica de telemetría | `ANT#<id>` | `MET#<observedAt>#<eventId>` | — | TTL de 30 días (dato crudo); campo `applied` para idempotencia |
| Idempotencia de telemetría | `EVT#<eventId>` | `EVT` | — | TTL de 30 días |
| Estado de antena | `ANT#<id>` | `STATE` | — | CAS por `version`; últimas 10 lecturas para la tendencia |
| Episodio de anomalía | `ANT#<id>` | `EPI#<startedAt>#<id>` | GSI1 `EPISODES` / `<startedAt>#<ant>` | Base de la recurrencia; **sin TTL** |
| Incidente | `INC#<id>` | `META` | GSI1 `INCZONE#<zone>` / `<openedAt>#<id>`; GSI2 `INCQ#ACTIVE` / `<9999-score>#…` o `INCQ#CLOSED` / `<closedAt>#…` | `version` para CAS; contadores con ADD atómico |
| Bloqueo de clave lógica | `INCKEY#INFRA#<ant>` o `INCKEY#COLL#<zone>#<fam>` | `ACTIVE` | — | `attribute_not_exists` ⇒ **un solo incidente activo por clave lógica** |
| Usuario afectado | `INC#<id>` | `USR#<userHash>` | — | `attribute_not_exists` ⇒ cada persona se cuenta una sola vez |
| Relación | `INC#<id>` | `REL#RPT#…`, `REL#ANT#…`, `REL#INC#…` | — | Evidencia; los incidentes relacionados no comparten conteo de usuarios |
| Historial del incidente | `INC#<id>` | `HIST#<at>#<eventId>` | — | El sufijo determinista evita duplicados al reintentar |
| Análisis de IA | `INC#<id>` | `AI#<generatedAt>` | — | `source` = `VERTEX_AI_GEMINI` o `AI_UNAVAILABLE` |
| Caché de IA | `AICACHE#<hash ctx>` | `AI` | — | TTL de 7 días |
| Notificación | `NOTIF#<sha256(dedupKey)>` | `NOTIF` | GSI1 `NOTIFS#<incident or ticket>`; GSI2 `NOTIFT#<ticket>` | Deduplicada; estado, proveedor, error y fechas |
| Outbox | `OUTBOX#<eventId>` | `OUTBOX` | GSI1 `OUTBOX#PENDING` / `<createdAt>` | Se elimina del GSI al publicarse; TTL de 7 días tras la publicación |
| Procesamiento | `PROC#<eventId>` | `PROC` | GSI1 `PROC#<estado>` / `<updatedAt>` | Ejecución de Step Functions, intentos y error; TTL de 30 días |
| Operador | `USER#<username>` | `USER` | — | Hash scrypt + sal; rol |
| Límite de tasa | `RL#<ipHash>#<minuto>` | `RL` | — | ADD atómico condicional; TTL de 120 s |
| Simulador | `SIM#CONFIG` | `CONFIG` | — | Modos forzados por antena |

## Patrones de consulta (sin Scan)

| Consulta | Operación |
|---|---|
| Ventana de 24 h por zona y familia | Query sobre la tabla base `ZF#…` con `BETWEEN`, **ConsistentRead** |
| Historial de métricas de una antena | Query `ANT#<id>` con `MET#from` hasta `MET#to` |
| Episodios para recurrencia | Query `ANT#<id>` con `begins_with EPI#` |
| Cola de incidentes por prioridad | Query GSI2 `INCQ#ACTIVE` (orden ascendente del puntaje invertido) |
| Incidentes por zona y rango (analítica) | Query GSI1 `INCZONE#<zone>` con `BETWEEN` |
| Reportes por rango (máximo 31 días) | Una Query GSI2 por día `RPTDAY#<día>` |
| Reconciliación del outbox | Query GSI1 `OUTBOX#PENDING` con `createdAt < now − 2 min` |

## Consistencia y concurrencia

- **Escritura de un reporte:** una sola `TransactWriteItems` atómica que incluye idempotencia, META, PII, punto de correlación, token, historial y outbox. Solo responde 201 después de confirmar la escritura.
- **Un incidente activo por clave lógica:** el ítem `INCKEY…/ACTIVE` se crea con `attribute_not_exists` en la misma transacción que el incidente. Quien pierde la carrera reintenta y actualiza el incidente existente.
- **Hot item:** asociar reportes solo incrementa contadores (`ADD`) y crea `USR#`/`REL#` con `attribute_not_exists`. Los cambios estructurales (antenas, estado, episodios) usan CAS por `version`. Medido en local: 1000 reportes simultáneos, 0 fallos y conteos exactos.
- **GSI con consistencia eventual:** las decisiones críticas (ventana de 24 h, bloqueos, usuarios) se leen de la **tabla base** con lectura consistente. Los GSI solo se usan para listados y analítica.
- **Eventos tardíos:** las métricas fuera de orden se guardan, pero no hacen retroceder el estado de la antena. Los reportes con más de 72 h se asocian a incidentes existentes, pero no abren colectivos nuevos.

## Retención, backups y restauración

- **TTL solo en datos temporales:** idempotencia (30 días), métricas crudas (30 días), outbox publicado (7 días), procesamiento (30 días), caché de IA (7 días) y rate limit (120 s). Historial, episodios, incidentes y reportes **no expiran**.
- **PITR** (35 días) en el entorno desplegado. Para restaurar: `aws dynamodb restore-table-to-point-in-time --source-table-name telecorp-sentinel-dev --target-table-name telecorp-sentinel-dev-restore --restore-date-time <ISO>`; luego se apunta `TABLE_NAME` a la tabla restaurada.
- `DeletionPolicy: Retain` en la tabla: `serverless remove` no borra los datos.
- **Alta disponibilidad:** DynamoDB replica en 3 zonas de disponibilidad de la región. No hay réplica multirregión ni multinube; se podría crecer con Global Tables.

## Límites del MVP y crecimiento

- Las particiones `INCQ#ACTIVE`, `RPTDAY#<día>` y `OUTBOX#PENDING` concentran escrituras. Con alto volumen se fragmentarían en buckets (`RPTDAY#<día>#<0..N>`) y se consultarían en paralelo.
- La ventana de correlación lee como máximo 5000 puntos por zona y familia. Con más volumen se agregarían contadores por hora con conjuntos HyperLogLog de `userHash`.
