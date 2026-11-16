# Guía de demostración paso a paso (para grabar el video)

Complementa el guion de `docs/demo-script.md` (4:40). Usa **solo datos ficticios** y la cuenta de operador asignada para el video. Nunca uses credenciales personales de AWS ni de Google.

## 0. Antes de grabar (unos 10 minutos)

| # | Acción | Resultado esperado |
|---|---|---|
| 0.1 | Abre Chrome en una **ventana de invitado o incógnito**, a 1920×1080 con zoom al 110 %. Cierra otras pestañas y silencia las notificaciones. | Ventana limpia |
| 0.1b | **Inicia el Learner Lab** de AWS Academy (indicador verde). Los recursos existen aunque el laboratorio esté detenido, pero para la consola de AWS hace falta la sesión activa. | Laboratorio iniciado |
| 0.2 | Abre el **portal**: https://e8iarrhhf8.execute-api.us-east-1.amazonaws.com/ (redespliegue del 2026-11-16 en la nueva cuenta de AWS Academy). | Banner "Proyecto académico con datos sintéticos" e Inicio |
| 0.3 | Entra en **Acceso operador** (`/operador/login`) con el usuario `operador.demo`. La contraseña está en `.local/operator-credentials-cloud.txt` (nunca la muestres en pantalla). | Panel de operaciones |
| 0.4 | **Calienta** la plataforma: abre una vez Panel, Incidentes, Antenas, Reportes, Analítica y Laboratorio. | La primera carga tarda unos 3 s (arranque en frío); luego, menos de 1 s |
| 0.5 | En **Laboratorio**, pulsa **"Emitir un minuto de telemetría"**. | Las antenas pasan a "Normal". Sin lecturas durante 3 min vuelven a "Sin datos" (es correcto: falta de datos ≠ 0) |
| 0.6 | Elige los datos de la demo en `datos-ficticios.md`: una **zona + "SMS no llegan"** limpia y un **índice inicial nuevo**. | Anótalos en un papel |
| 0.7 | Ten listos los **clips de consola**: Step Functions lo grabas tú desde tu consola de AWS Academy (oculta el ID de cuenta); Cloud Run lo graba el dueño del proyecto de Google Cloud (o te da acceso de solo lectura, ver `acceso-seguro.md`). | 2 clips de unos 20 s |

> Si un número no coincide, el guion permite decirlo. **Nunca simules resultados.**

## 1. El dolor (0:00–0:30)
- **Pantalla:** Inicio del portal.
- **Di:** lo indicado en el guion.
- **Muestra:** el banner de datos sintéticos (honestidad) y los 3 pasos (Reporta, Detectamos, Te avisamos).

## 2. Portal y reporte ciudadano (0:30–1:05)
1. Pulsa **Reportar problema**.
2. Llena el formulario con el **Ciudadano ficticio 1** de `datos-ficticios.md`: tipo de documento DNI, número, número de servicio, zona, fecha (la que viene por defecto), tipo de problema y descripción. **No marques** "Acepto recibir avisos".
3. Pulsa **Enviar reporte**. Resultado: "Reporte registrado", el **ticket** `TCK-…` y el **token privado**.
4. Pulsa **Ver estado**. Resultado: el historial muestra *Registrada* → *En revisión* (evaluado por el flujo en la nube). Si aún dice *Registrada*, espera unos 5 s y pulsa **Consultar** de nuevo.
5. **Di:** "Escritura durable e idempotente. El token se guarda solo como hash y los datos personales se cifran."

## 3. Regla 9 + 1 y antena caída (1:05–1:55)
1. **Laboratorio** → Escenario **"Reportes de usuarios distintos (sintéticos)"**:
   - Zona: la zona limpia elegida.
   - Tipo de problema: **SMS no llegan**.
   - Usuarios: **9**.
   - Índice inicial: **N** (tu número nuevo).
   - Repetir usuario #: **N+3**.
   - Pulsa **Ejecutar**.
2. Espera unos 15 s y abre **Incidentes**. Resultado: **no aparece** ningún colectivo de mensajería en esa zona. **Di:** "9 personas y una repetida: no hay colectivo."
3. Vuelve al **Laboratorio**, con el mismo escenario:
   - Usuarios: **1**.
   - Índice inicial: **N+9**.
   - Deja vacío "Repetir usuario".
   - Pulsa **Ejecutar**.
4. Espera unos 15–20 s y abre **Incidentes**. Resultado: aparece **"Posible incidente colectivo de mensajeria en <zona>"** con **10** reportantes y la etiqueta **"Investigación pendiente"**.
5. **Laboratorio** → **"Antena inhabilitada (0 GB/min)"** → antena de **la misma zona** (ver `datos-ficticios.md`) → **Ejecutar**.
6. Espera unos 15 s y abre **Incidentes**. Resultado: aparece el incidente de **infraestructura** de esa antena. Abre el **colectivo**: en Evidencia aparece "Relacionado con INC-…" y los reportantes siguen en **10** (no se duplican).

## 4. Step Functions y prioridad (1:55–2:35)
1. **Clip 1** (consola AWS Step Functions): grafo de una ejecución *Succeeded* con Choice, Map, Retry y Catch.
2. Vuelve al **detalle del incidente de infraestructura** → tarjeta **"Prioridad explicada"**: puntaje /100 y los 5 factores con sus barras.
3. **Di:** "Prioridad determinista y explicable; la IA no interviene. Un hospital pesa más que una zona residencial."

## 5. IA en Google Cloud (2:35–3:15)
1. En el mismo detalle, tarjeta **"Análisis y recomendaciones"**: etiqueta **"Google Vertex AI · gemini-3.5-flash-lite"**, resumen, causas (hipótesis), acciones e incertidumbres. Si aún no aparece, espera unos 10 s; el panel se refresca solo cada 15 s.
2. **Clip 2** (consola Google Cloud Run): servicio `telecorp-ai`, "Requiere autenticación" y escalado mínimo 0.
3. **Di:** "Segunda nube. AWS invoca Cloud Run privado sin claves (Workload Identity Federation). Gemini recibe datos anonimizados y sugiere; no decide."

## 6. Operación, recurrencia y analítica (3:15–3:55)
1. En el detalle del incidente de infraestructura → **Acciones del operador**:
   - Nuevo estado: **En atención**. Motivo: `Cuadrilla asignada (demo)`. Pulsa **Aplicar cambio**.
   - Repite con **Solucionada**. Motivo: `Servicio verificado por el operador (demo)`.
   - Resultado: la **Cronología** muestra ambos cambios con fecha, actor y motivo.
2. **Antenas** → selecciona la antena con **revisión estructural** (ver `datos-ficticios.md`). Resultado: "Episodios (7 días): 3 · ⚠ Revisión estructural" y la tabla de episodios.
3. **Analítica**: KPIs (antenas caídas, saturadas e inhabilitadas; incidentes activos; reportantes únicos frente a usuarios estimados; **MTTD/MTTR**) y las gráficas. **Di:** "Métricas calculadas sobre datos persistidos."

## 7. Arquitectura (3:55–4:25)
- Muestra `arquitectura.png` a pantalla completa y recórrela de izquierda a derecha: portal y API → DynamoDB → Streams y SQS → Step Functions → Google Cloud (Cloud Run + Vertex AI) → notificaciones.

## 8. Cierre (4:25–4:40)
- Vuelve a Inicio y di el cierre del guion.

## Si algo falla durante la grabación

| Síntoma | Qué hacer |
|---|---|
| "Sesión expirada" | Vuelve a iniciar sesión (el token dura 1 h) |
| No aparece el colectivo | Espera 15 s y pulsa F5. Verifica la misma zona, el tipo "SMS no llegan" y que los índices sean nuevos. Si la zona ya tenía un colectivo activo, usa otra de la lista |
| El análisis dice "Respaldo / AI_UNAVAILABLE" | Gemini no respondió a tiempo: es el respaldo etiquetado y es válido mostrarlo. Dilo tal cual |
| Las antenas muestran "Sin datos" | Laboratorio → "Emitir un minuto de telemetría" |
| Error 429 | Espera 1 minuto (límite de 20 reportes por minuto por IP en el formulario público) |

## Qué NO mostrar
Credenciales, archivos `.local`, la consola de AWS o GCP con IDs de cuenta visibles, correos personales ni la terminal. Usa solo datos ficticios.
