# Acceso seguro para quien graba el video (sin compartir credenciales personales)

Principio: **nadie recibe las credenciales de AWS Academy, de Google Cloud ni el contenido de `.local/`** del dueño del proyecto. Cada persona usa un acceso propio, limitado y revocable.

## 1. Plataforma (portal y consola de operador): cuenta propia
- El dueño crea un operador exclusivo para el video:
  ```bash
  OPERATOR_PASSWORD='<aleatoria>' TABLE_NAME=telecorp-sentinel-dev AWS_REGION=us-east-1 npx tsx scripts/create-operator.ts operador.video
  ```
- Envía **por separado**:
  - **La URL del portal y el usuario:** van en la carpeta de entrega.
  - **La contraseña:** por un canal distinto y efímero (en persona, o un mensaje que se borre).
  - Nunca juntas en el mismo archivo.
- La sesión expira en 1 hora y el inicio de sesión tiene límite de intentos.
- **Revocar** al terminar (lo hace el dueño, con sus credenciales locales):
  ```bash
  aws dynamodb delete-item --table-name telecorp-sentinel-dev --region us-east-1 --key '{"pk":{"S":"USER#operador.video"},"sk":{"S":"USER"}}'
  ```
  Los tokens ya emitidos caducan en menos de 1 hora.

## 2. Consola de AWS (Step Functions): clip grabado por el dueño
AWS Academy no permite crear usuarios ni roles IAM para terceros, y las credenciales del laboratorio son personales. Por eso **el dueño graba un clip de unos 20 s**, sin mostrar el ID de la cuenta:
1. Consola AWS → **Step Functions** → `telecorp-sentinel-dev-incident-workflow` → **Executions**.
2. Abrir una ejecución **Succeeded** reciente (`evt-epi-…` o `evt-rpt-…`) → vista **Graph**, que muestra Choice, Map (AnalyzeWithGCP) y la ruta seguida.
3. Opcional: pestaña "Events" para mostrar los reintentos.

Alternativa: una videollamada en la que el dueño comparte pantalla mientras su compañero graba.

## 3. Consola de Google Cloud (Cloud Run): clip o acceso de solo lectura
- **Opción A (más simple): clip de unos 15 s** grabado por el dueño:
  - Cloud Run → `telecorp-ai` → pestaña **Security**: "Require authentication".
  - Pestaña **Revisions**: min instances 0 / max 2.
- **Opción B: acceso de solo lectura** a la cuenta de Google del compañero (revocable), con estos tres comandos:
  ```bash
  gcloud projects add-iam-policy-binding <PROYECTO> --member "user:<correo-del-compañero>" --role roles/run.viewer
  ```
  ```bash
  gcloud projects add-iam-policy-binding <PROYECTO> --member "user:<correo-del-compañero>" --role roles/logging.viewer
  ```
  ```bash
  gcloud projects add-iam-policy-binding <PROYECTO> --member "user:<correo-del-compañero>" --role roles/aiplatform.viewer
  ```
  Para revocar, usa los mismos comandos con `remove-iam-policy-binding`. Estos roles no permiten desplegar, borrar ni gastar.

## 4. Qué NUNCA compartir
- `~/.aws/credentials` y el bloque "AWS Details" del Learner Lab.
- `gcloud auth` y `application_default_credentials.json`.
- Toda la carpeta `.local/`: contraseñas, clave local y configuración.
- El enlace de inicio de sesión de Serverless.
- El prompt o las conversaciones usadas para desarrollar.
