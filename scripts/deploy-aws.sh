#!/usr/bin/env bash
# Despliega TeleCorp Sentinel en AWS (Serverless Framework v4 + CloudFormation) y
# publica el frontend. Idempotente (re-ejecutable). Pide confirmación antes de crear recursos.
#
# Requisitos: AWS CLI v2 con credenciales (AWS Academy: "AWS Details" en ~/.aws/credentials,
# expiran a las 4 h), Node.js 22+, `npx serverless login` (una vez).
#
# Variables (opcionales):
#   STAGE=dev  AWS_REGION=us-east-1  LAB_ROLE_ARN=(por defecto arn:aws:iam::<cuenta>:role/LabRole)
#   FRONTEND_MODE=s3website|cloudfront|none   (AWS Academy bloquea CloudFront => s3website)
#   NOTIFY_EMAIL=<correo de prueba>  => se suscribe al tema SNS (confirmar el correo de AWS) y queda en la lista permitida
#   SES_FROM_EMAIL=<identidad verificada>  (sólo en cuentas con SES; en Academy está bloqueado)
#   AI_SERVICE_URL, GCP_PROJECT_NUMBER, GCP_INVOKER_SA, AI_AUTH_MODE=wif  (salida de infra/gcp/deploy-gcp.sh)
#   SIMULATOR_ENABLED=false  TRACING=false  ALERT_EMAIL=  SCHEDULE_KIND=rule  ASSUME_YES=1
#   REPORTS_PER_MINUTE_PER_IP=20 (súbalo sólo durante una prueba de carga y vuelva a desplegar sin él)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-dev}"
REGION="${AWS_REGION:-us-east-1}"
FRONTEND_MODE="${FRONTEND_MODE:-s3website}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

command -v aws >/dev/null || { echo "Instale AWS CLI v2"; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || { echo "Credenciales AWS inválidas o expiradas (reinicie el Learner Lab y actualice ~/.aws/credentials)"; exit 1; }
LAB_ROLE_ARN="${LAB_ROLE_ARN:-arn:aws:iam::${ACCOUNT}:role/LabRole}"

echo "Cuenta AWS: $ACCOUNT · Región: $REGION · Stage: $STAGE · Rol: ${LAB_ROLE_ARN##*/} · Frontend: $FRONTEND_MODE"
echo "Coste por uso (no es cero): Lambda, API Gateway, DynamoDB on-demand + PITR, SQS, Step Functions (por transición),"
echo "Secrets Manager (~0,40 USD/mes), CloudWatch (logs 14 d, 7 alarmas), S3, SNS. Estimación en README."
echo "Simulador programado: ${SIMULATOR_ENABLED:-false} (actívelo sólo durante la demo)."
if [ "${ASSUME_YES:-0}" != "1" ]; then
  read -r -p "¿Desplegar en AWS? (escriba 'si'): " ok
  [ "$ok" = "si" ] || { echo "Cancelado."; exit 1; }
fi

echo "== Build backend"
( cd "$ROOT" && npm ci --no-audit --no-fund >/dev/null && npm run build -w backend >/dev/null )

STACK="telecorp-sentinel-$STAGE"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }

ALLOWED="${NOTIFY_ALLOWED_RECIPIENTS:-${NOTIFY_EMAIL:-}}"
CORS="${CORS_ORIGINS:-$(out WebsiteUrl)}"
[ -z "$CORS" ] || [ "$CORS" = "None" ] && CORS="http://localhost:5173"

deploy() {
  # Serverless rechaza --param con valor vacío: sólo se envían los que tienen valor
  # (los vacíos toman el default de backend/serverless.yml).
  local args=() kv
  for kv in     "region=$REGION"     "labRoleArn=$LAB_ROLE_ARN"     "frontendMode=$FRONTEND_MODE"     "corsOrigins=$1"     "simulatorEnabled=${SIMULATOR_ENABLED:-false}"     "scheduleKind=${SCHEDULE_KIND:-rule}"     "tracing=${TRACING:-false}"     "lambdaTracing=$([ "${TRACING:-false}" = true ] && echo Active || echo PassThrough)"     "sesFromEmail=${SES_FROM_EMAIL:-}"     "notifyEmailSubscriber=${NOTIFY_EMAIL:-}"     "notifyAllowedRecipients=$ALLOWED"     "aiServiceUrl=${AI_SERVICE_URL:-}"     "aiAuthMode=${AI_AUTH_MODE:-wif}"     "gcpProjectNumber=${GCP_PROJECT_NUMBER:-}"     "gcpInvokerSa=${GCP_INVOKER_SA:-}"     "alertEmail=${ALERT_EMAIL:-}"     "reportsPerMinutePerIp=${REPORTS_PER_MINUTE_PER_IP:-}"; do
    [ -n "${kv#*=}" ] && args+=("--param=$kv")
  done
  ( cd "$ROOT/backend" && npx serverless deploy --stage "$STAGE" --region "$REGION" "${args[@]}" < /dev/null )
}

echo "== Serverless deploy"
deploy "$CORS"
API_URL="$(out HttpApiUrl)"
echo "API: $API_URL"

SITE=""
if [ "$FRONTEND_MODE" = "s3website" ]; then
  BUCKET="$(out WebsiteBucket)"; SITE="$(out WebsiteUrl)"
  echo "== Frontend -> sitio web S3 ($SITE)"
  ( cd "$ROOT/frontend" && VITE_API_BASE_URL="$API_URL" npm run build >/dev/null )
  aws s3 sync "$ROOT/frontend/dist" "s3://$BUCKET" --delete --region "$REGION" >/dev/null
elif [ "$FRONTEND_MODE" = "cloudfront" ]; then
  BUCKET="$(out FrontendBucket)"; SITE="$(out CloudFrontUrl)"
  echo "== Frontend -> S3 privado + CloudFront ($SITE)"
  ( cd "$ROOT/frontend" && VITE_API_BASE_URL="$API_URL" npm run build >/dev/null )
  aws s3 sync "$ROOT/frontend/dist" "s3://$BUCKET" --delete --region "$REGION" >/dev/null
  aws cloudfront create-invalidation --distribution-id "$(out CloudFrontDistributionId)" --paths '/*' >/dev/null
fi
if [ -n "$SITE" ] && [ "$SITE" != "$CORS" ]; then
  echo "== Segunda pasada: CORS restringido al origen del frontend ($SITE)"
  deploy "$SITE"
fi

echo
echo "Portal: ${SITE:-(frontend local: VITE_API_BASE_URL=$API_URL npm run dev:web)}"
echo "API:    $API_URL"
[ -n "${NOTIFY_EMAIL:-}" ] && echo "Revise el correo de prueba y CONFIRME la suscripción de AWS SNS (sin confirmar, las notificaciones no llegan)."
echo "Crear operador (la contraseña se lee de la variable; no se imprime):"
echo "  OPERATOR_PASSWORD='<elija>' TABLE_NAME=$(out TableName) AWS_REGION=$REGION npx tsx scripts/create-operator.ts operador.demo"
echo "Smoke test: API_URL=$API_URL npx tsx scripts/smoke-test.ts"
