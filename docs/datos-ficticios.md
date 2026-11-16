# Datos ficticios para la demo

Todos los datos son **inventados**. Las identidades solo sirven para contar "personas distintas": se guardan como HMAC (seudónimo irreversible) y **nunca se contacta a nadie**.

## Ciudadanos ficticios (formulario "Reportar problema")

| # | Tipo doc. | N.º documento | N.º de servicio | Zona | Tipo de problema | Descripción |
|---|---|---|---|---|---|---|
| 1 | DNI | 40112233 | 900 111 001 | Miramar | Sin señal / sin cobertura | Desde la tarde no tengo señal en el malecón, ni para llamar. |
| 2 | DNI | 40112234 | 900 111 002 | Las Palmeras | Internet muy lento | El internet móvil está lentísimo, no cargan los videos. |
| 3 | CE | CE-000777 | 900 111 003 | Campus Sur | Llamadas que se cortan | Las llamadas se cortan a los pocos segundos cerca de la universidad. |

- No marques "Acepto recibir avisos": el correo de demostración no está suscrito.
- Fecha y hora: deja la que propone el formulario (no se aceptan fechas futuras).

## Plan de demostración 9 + 1 (Laboratorio)

Elige **una** opción. Cada opción tiene su zona, su familia de problema **limpia** y sus índices **nuevos**. No reutilices índices: repetirlos equivale a las mismas personas.

| Opción | Zona | Tipo de problema | Paso 1: 9 usuarios + repetido | Paso 2: el décimo | Antena para "Antena inhabilitada" |
|---|---|---|---|---|---|
| **A (recomendada)** | Centro Cívico (servicios críticos) | SMS no llegan | Usuarios 9 · Índice inicial **4100000** · Repetir **4100003** | Usuarios 1 · Índice **4100009** | **ANT-CCV-02** |
| B | Santa Rosa Norte (hospital) | SMS no llegan | Usuarios 9 · Índice **4200000** · Repetir **4200003** | Usuarios 1 · Índice **4200009** | **ANT-SRN-01** |
| C | Valle Industrial (industrial) | SMS no llegan | Usuarios 9 · Índice **4300000** · Repetir **4300003** | Usuarios 1 · Índice **4300009** | **ANT-VIN-01** |

> Verificado con `scripts/preflight-demo.ts` el 2026-11-16 en el nuevo despliegue: las tres opciones están limpias y sus antenas no tienen incidente activo. **No uses Campus Sur** para la regla 9 + 1: ya tiene un colectivo de la prueba E2E.

Resultados esperados:
- **Paso 1:** sin colectivo.
- **Paso 2:** "Posible incidente colectivo de mensajeria en <zona>" con **10 reportantes** e **investigación pendiente**.
- **Antena:** nuevo incidente de infraestructura, relacionado con el colectivo; los reportantes siguen en 10.

> Si se usa una opción (por ejemplo, en un ensayo), deja de estar limpia: usa la siguiente. Para confirmar qué combinaciones siguen limpias, el dueño del proyecto puede ejecutar `scripts/preflight-demo.ts`.

## Ya preparado en la nube

| Elemento | Dónde verlo | Nota |
|---|---|---|
| Antena **recurrente** ANT-CSU-02 (Campus Sur): 3 episodios (caída, inhabilitada, saturada) ⇒ "revisión estructural" | Antenas → ANT-CSU-02 | Regenerada el 2026-11-16 en el nuevo despliegue; válida hasta el 2026-11-23. Después, Laboratorio → "Recurrencia: 3 episodios cortos" en otra antena libre |
| Incidentes con análisis **Gemini real** (3: colectivo e infraestructura en Campus Sur) | Incidentes → etiqueta "Gemini" | Generados por la prueba E2E multinube (12/12) y la recurrencia |
| Historial, MTTD/MTTR y gráficas | Analítica | Calculado sobre los datos sintéticos persistidos (pocos datos: el despliegue es nuevo) |

> El despliegue nuevo **no** incluye los 200 reportes de la prueba de carga anterior (no se repitió para ahorrar créditos). La evidencia de esa prueba sigue en `docs/evidence/load-cloud-*.json`.
