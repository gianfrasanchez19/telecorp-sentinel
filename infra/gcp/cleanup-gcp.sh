#!/usr/bin/env bash
# Elimina los recursos de GCP creados por deploy-gcp.sh (pide confirmación).
set -euo pipefail
# shellcheck source=/dev/null
source "$(dirname "$0")/_gcloud-shim.sh"
: "${GCP_PROJECT_ID:?Defina GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${SERVICE_NAME:-telecorp-ai}"
echo "Se eliminará en $GCP_PROJECT_ID: Cloud Run '$SERVICE', pool WIF 'telecorp-aws-pool' (borrado lógico 30 días), cuentas de servicio telecorp-ai-*, secreto telecorp-ai-hmac si existe."
read -r -p "Escriba 'eliminar' para confirmar: " ok
[ "$ok" = "eliminar" ] || { echo "Cancelado."; exit 1; }
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud run services delete "$SERVICE" --region "$REGION" --quiet || true
gcloud iam workload-identity-pools delete telecorp-aws-pool --location global --quiet || true
for sa in telecorp-ai-runtime telecorp-ai-invoker; do
  gcloud iam service-accounts delete "$sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" --quiet || true
done
gcloud secrets delete telecorp-ai-hmac --quiet 2>/dev/null || true
echo "Recursos eliminados. Las imágenes en Artifact Registry (cloud-run-source-deploy) pueden borrarse manualmente para evitar costes de almacenamiento."
