#!/usr/bin/env bash
# ALTERNATIVA EXPLÍCITA (sólo si WIF no es posible en la cuenta): autenticación HMAC.
# - Deriva la subclave "ai-hmac" desde el secreto de AWS Secrets Manager (HKDF) y la
#   guarda en GCP Secret Manager SIN mostrarla (tubería directa).
# - Redespliega Cloud Run con AUTH_MODE=hmac, max-instances=1 (caché de nonces anti-replay)
#   y acceso público a nivel de red: la autenticación la hace la firma HMAC.
# Luego desplegar el backend con aiAuthMode=hmac.
set -euo pipefail
: "${GCP_PROJECT_ID:?}"; : "${AWS_SECRET_ID:?Defina AWS_SECRET_ID (p. ej. telecorp-sentinel/dev/app)}"
REGION="${GCP_REGION:-us-central1}"; SERVICE="${SERVICE_NAME:-telecorp-ai}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
read -r -p "Esto expone el endpoint protegido sólo por HMAC (alternativa). Escriba 'si' para continuar: " ok
[ "$ok" = "si" ] || exit 1
gcloud secrets describe telecorp-ai-hmac --project "$GCP_PROJECT_ID" >/dev/null 2>&1 || \
  gcloud secrets create telecorp-ai-hmac --project "$GCP_PROJECT_ID" --replication-policy automatic
( cd "$ROOT/backend" && npx tsx ../scripts/derive-ai-hmac.ts ) | gcloud secrets versions add telecorp-ai-hmac --project "$GCP_PROJECT_ID" --data-file=-
RUNTIME_SA="telecorp-ai-runtime@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
gcloud secrets add-iam-policy-binding telecorp-ai-hmac --project "$GCP_PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null
gcloud run services update "$SERVICE" --region "$REGION" --project "$GCP_PROJECT_ID" \
  --update-env-vars AUTH_MODE=hmac --set-secrets AI_HMAC_KEY=telecorp-ai-hmac:latest --max-instances 1
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --project "$GCP_PROJECT_ID" --member allUsers --role roles/run.invoker >/dev/null
echo "Modo HMAC activo. Despliegue el backend con --param=aiAuthMode=hmac"
