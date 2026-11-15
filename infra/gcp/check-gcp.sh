#!/usr/bin/env bash
# Comprobación de SÓLO LECTURA del proyecto de Google Cloud (no crea recursos ni genera coste).
# Uso: GCP_PROJECT_ID=mi-proyecto bash infra/gcp/check-gcp.sh
set -uo pipefail
: "${GCP_PROJECT_ID:?Defina GCP_PROJECT_ID}"
command -v gcloud >/dev/null || { echo "Instale Google Cloud CLI: https://cloud.google.com/sdk/docs/install"; exit 1; }
[ -n "$(gcloud config get-value account 2>/dev/null)" ] || { echo "Ejecute: gcloud auth login"; exit 1; }
echo "Proyecto: $GCP_PROJECT_ID ($(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || echo 'sin acceso'))"
BILL="$(gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo desconocido)"
echo "Facturación habilitada: $BILL  (Vertex AI y Cloud Build la requieren; use créditos de prueba/educativos si los tiene)"
ENABLED="$(gcloud services list --enabled --project "$GCP_PROJECT_ID" --format='value(config.name)' 2>/dev/null)"
for api in run.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com; do
  if grep -qx "$api" <<<"$ENABLED"; then echo "  OK  $api"; else echo "  --  $api (deploy-gcp.sh la habilitará)"; fi
done
echo "Para elegir el modelo: consulte Vertex AI > Model Garden en su región y pruébelo con:"
echo "  GOOGLE_CLOUD_PROJECT=$GCP_PROJECT_ID VERTEX_LOCATION=us-central1 GEMINI_MODEL=<id> python ai-service/scripts/check_model.py"
echo "Listo (no se creó ningún recurso)."
