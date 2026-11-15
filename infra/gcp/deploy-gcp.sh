#!/usr/bin/env bash
# Despliega el microservicio de IA en Google Cloud (Cloud Run PRIVADO + Vertex AI) y
# configura Workload Identity Federation para que AWS Lambda (rol LabRole) lo invoque
# SIN claves de cuenta de servicio.
#
# Requisitos: gcloud autenticado (gcloud auth login), proyecto con facturación.
# Uso:
#   GCP_PROJECT_ID=mi-proyecto AWS_ACCOUNT_ID=123456789012 GEMINI_MODEL=<modelo-verificado> \
#     bash infra/gcp/deploy-gcp.sh
# Variables opcionales: GCP_REGION (us-central1), VERTEX_LOCATION (us-central1),
#   AWS_ROLE_NAME (LabRole), AI_MAX_INSTANCES (2), SERVICE_NAME (telecorp-ai), ASSUME_YES=1
set -euo pipefail

: "${GCP_PROJECT_ID:?Defina GCP_PROJECT_ID}"
: "${AWS_ACCOUNT_ID:?Defina AWS_ACCOUNT_ID (12 dígitos de la cuenta AWS / AWS Academy)}"
: "${GEMINI_MODEL:?Defina GEMINI_MODEL con un modelo disponible (verifíquelo con ai-service/scripts/check_model.py)}"
REGION="${GCP_REGION:-us-central1}"
VERTEX_LOCATION="${VERTEX_LOCATION:-$REGION}"
AWS_ROLE_NAME="${AWS_ROLE_NAME:-LabRole}"
MAX_INSTANCES="${AI_MAX_INSTANCES:-2}"
SERVICE="${SERVICE_NAME:-telecorp-ai}"
POOL="telecorp-aws-pool"
PROVIDER="telecorp-aws-provider"
RUNTIME_SA="telecorp-ai-runtime@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA="telecorp-ai-invoker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "== Verificación de identidad (no se muestran credenciales)"
ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
[ -n "$ACCOUNT" ] || { echo "No hay sesión de gcloud. Ejecute: gcloud auth login"; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
echo "Cuenta gcloud: (sesión activa) · Proyecto: $GCP_PROJECT_ID ($PROJECT_NUMBER) · Región: $REGION · Modelo: $GEMINI_MODEL"
echo "Se crearán: APIs habilitadas, 2 cuentas de servicio, servicio Cloud Run (min 0 / max $MAX_INSTANCES), pool WIF."
echo "COSTE: Cloud Run escala a 0 (sin coste en reposo); Vertex AI cobra por tokens; Cloud Build/Artifact Registry por uso. No es coste cero."
if [ "${ASSUME_YES:-0}" != "1" ]; then
  read -r -p "¿Continuar con la creación de recursos en GCP? (escriba 'si'): " ok
  [ "$ok" = "si" ] || { echo "Cancelado."; exit 1; }
fi

gcloud config set project "$GCP_PROJECT_ID" >/dev/null
echo "== Habilitando APIs"
gcloud services enable run.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com

echo "== Cuentas de servicio (mínimo privilegio)"
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || gcloud iam service-accounts create telecorp-ai-runtime --display-name "TeleCorp AI runtime (Cloud Run -> Vertex AI)"
gcloud iam service-accounts describe "$INVOKER_SA" >/dev/null 2>&1 || gcloud iam service-accounts create telecorp-ai-invoker --display-name "TeleCorp AI invoker (AWS via WIF)"
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role roles/aiplatform.user --condition=None >/dev/null

echo "== Desplegando Cloud Run (privado)"
gcloud run deploy "$SERVICE" --source "$ROOT/ai-service" --region "$REGION" \
  --no-allow-unauthenticated --service-account "$RUNTIME_SA" \
  --min-instances 0 --max-instances "$MAX_INSTANCES" --concurrency 20 --cpu 1 --memory 512Mi --timeout 30 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$GCP_PROJECT_ID,VERTEX_LOCATION=$VERTEX_LOCATION,GEMINI_MODEL=$GEMINI_MODEL,AUTH_MODE=iam,ALLOWED_INVOKER=$INVOKER_SA"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --member "serviceAccount:$INVOKER_SA" --role roles/run.invoker >/dev/null

echo "== Workload Identity Federation (AWS -> GCP)"
gcloud iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" --location global --display-name "TeleCorp AWS"
MAPPING="google.subject=assertion.arn,attribute.aws_role=assertion.arn.contains('assumed-role') ? assertion.arn.extract('{account_arn}assumed-role/') + 'assumed-role/' + assertion.arn.extract('assumed-role/{role_name}/') : assertion.arn"
ROLE_ATTR="arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${AWS_ROLE_NAME}"
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool "$POOL" --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-aws "$PROVIDER" --workload-identity-pool "$POOL" --location global \
    --attribute-mapping "$MAPPING" --attribute-condition "attribute.aws_role=='${ROLE_ATTR}'"
else
  gcloud iam workload-identity-pools providers create-aws "$PROVIDER" --workload-identity-pool "$POOL" --location global \
    --account-id "$AWS_ACCOUNT_ID" --attribute-mapping "$MAPPING" --attribute-condition "attribute.aws_role=='${ROLE_ATTR}'"
fi
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.aws_role/${ROLE_ATTR}"
# Sólo ese rol de AWS puede obtener ID tokens del invocador (y nada más).
gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" --member "$PRINCIPAL" --role roles/iam.workloadIdentityUser >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" --member "$PRINCIPAL" --role roles/iam.serviceAccountOpenIdTokenCreator >/dev/null

echo
echo "Listo. Parámetros para backend/serverless.yml (no son secretos):"
echo "  aiServiceUrl=$URL"
echo "  aiAuthMode=wif"
echo "  gcpProjectNumber=$PROJECT_NUMBER"
echo "  gcpWifPool=$POOL"
echo "  gcpWifProvider=$PROVIDER"
echo "  gcpInvokerSa=$INVOKER_SA"
echo "Verifique que el servicio rechaza llamadas anónimas: curl -s -o /dev/null -w '%{http_code}' -X POST $URL/v1/analyze  (esperado 403)"
