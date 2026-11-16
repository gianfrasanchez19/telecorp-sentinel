#!/usr/bin/env bash
# Despliega TeleCorp Sentinel en AWS (Serverless Framework v4 + CloudFormation) y
# publica el frontend. Idempotente (re-ejecutable). Pide confirmación antes de crear recursos.
#
# Requisitos: AWS CLI v2 con credenciales (AWS Academy: "AWS Details" en ~/.aws/credentials,
# expiran a las 4 h), Node.js 22+, `npx serverless login` (una vez).
#
# Variables (opcionales):
#   STAGE=dev  AWS_REGION=us-east-1  LAB_ROLE_ARN=(por defecto arn:aws:iam::<cuenta>:role/LabRole)
#   FRONTEND_MODE=apigw|s3website|cloudfront|none  (apigw: SPA por el mismo API Gateway HTTPS con CSP/HSTS;
#                  recomendado en AWS Academy, donde CloudFront está bloqueado y el sitio S3 sería sólo HTTP)
#   NOTIFY_EMAIL=<correo de prueba>  => se suscribe al tema SNS (confirmar el correo de AWS) y queda en la lista permitida
#   SES_FROM_EMAIL=<identidad verificada>  (sólo en cuentas con SES; en Academy está bloqueado)
#   AI_SERVICE_URL, GCP_PROJECT_NUMBER, GCP_INVOKER_SA, AI_AUTH_MODE=wif  (salida de infra/gcp/deploy-gcp.sh)
#   SIMULATOR_ENABLED=false  TRACING=false  ALERT_EMAIL=  SCHEDULE_KIND=rule  ASSUME_YES=1
#   REPORTS_PER_MINUTE_PER_IP=20 (súbalo sólo durante una prueba de carga y vuelva a desplegar sin él)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-dev}"
# Configuración NO secreta recordada entre despliegues (URL de Cloud Run, proyecto, SA, modo
# del frontend...) en .local/ (ignorado por git): evita desactivar la IA por olvidar un parámetro.
CONF="$ROOT/.local/deploy-$STAGE.env"
if [ -f "$CONF" ]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_]+$ ]] || continue
    [ -z "${!k:-}" ] && export "$k=$v"
  done < "$CONF"
fi
REGION="${AWS_REGION:-us-east-1}"
FRONTEND_MODE="${FRONTEND_MODE:-apigw}"
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

echo "== Build"
( cd "$ROOT" && npm ci --no-audit --no-fund >/dev/null )
if [ "$FRONTEND_MODE" = "apigw" ]; then
  # Mismo origen que la API => base URL vacía (rutas relativas); el build del backend lo empaqueta en dist/web.
  ( cd "$ROOT/frontend" && VITE_API_BASE_URL="" npm run build >/dev/null )
fi
( cd "$ROOT" && npm run build -w backend >/dev/null )

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

# Si se cambia de modo, CloudFormation no puede borrar un bucket con objetos: vaciarlo antes.
OLD_BUCKET="$(out WebsiteBucket)"
if [ "$FRONTEND_MODE" != "s3website" ] && [ -n "$OLD_BUCKET" ] && [ "$OLD_BUCKET" != "None" ]; then
  echo "== Vaciando el sitio web S3 anterior ($OLD_BUCKET) para retirarlo"
  aws s3 rm "s3://$OLD_BUCKET" --recursive --region "$REGION" >/dev/null || true
  CORS="http://localhost:5173"
fi

echo "== Serverless deploy"
deploy "$CORS"
API_URL="$(out HttpApiUrl)"
echo "API: $API_URL"

SITE=""
if [ "$FRONTEND_MODE" = "apigw" ]; then
  SITE="$API_URL"
  echo "== Portal servido por API Gateway (HTTPS, mismo origen): $SITE/"
elif [ "$FRONTEND_MODE" = "s3website" ]; then
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

mkdir -p "$ROOT/.local"
[ -n "$SITE" ] && CORS_ORIGINS="${SITE%/}"   # próximos despliegues: una sola pasada
{
  for k in CORS_ORIGINS FRONTEND_MODE AI_SERVICE_URL AI_AUTH_MODE GCP_PROJECT_NUMBER GCP_INVOKER_SA NOTIFY_EMAIL SES_FROM_EMAIL ALERT_EMAIL SCHEDULE_KIND TRACING; do
    [ -n "${!k:-}" ] && echo "$k=${!k}"
  done
} > "$CONF"
echo "Configuración no secreta guardada en .local/deploy-$STAGE.env (ignorado por git)."

echo
echo "Portal: ${SITE:-(frontend local: VITE_API_BASE_URL=$API_URL npm run dev:web)}"
echo "API:    $API_URL"
[ -n "${NOTIFY_EMAIL:-}" ] && echo "Revise el correo de prueba y CONFIRME la suscripción de AWS SNS (sin confirmar, las notificaciones no llegan)."
echo "Crear operador (la contraseña se lee de la variable; no se imprime):"
echo "  OPERATOR_PASSWORD='<elija>' TABLE_NAME=$(out TableName) AWS_REGION=$REGION npx tsx scripts/create-operator.ts operador.demo"
echo "Smoke test: API_URL=$API_URL npx tsx scripts/smoke-test.ts"
