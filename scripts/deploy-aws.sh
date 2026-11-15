#!/usr/bin/env bash
# Despliega TeleCorp Sentinel en AWS (Serverless Framework v4 + CloudFormation) y
# publica el frontend en S3 privado + CloudFront. Idempotente (re-ejecutable).
#
# Requisitos: AWS CLI v2 con credenciales (en AWS Academy: copiar "AWS Details" a
# ~/.aws/credentials — expiran a las 4 h), Node.js 22, `npx serverless login`.
#
# Variables (todas opcionales salvo las marcadas):
#   STAGE=dev  AWS_REGION=us-east-1  LAB_ROLE_ARN=(por defecto arn:aws:iam::<cuenta>:role/LabRole)
#   SES_FROM_EMAIL=<identidad verificada en SES>   NOTIFY_ALLOWED_RECIPIENTS=<correos verificados, separados por coma>
#   AI_SERVICE_URL, GCP_PROJECT_NUMBER, GCP_INVOKER_SA, AI_AUTH_MODE=wif  (salida de infra/gcp/deploy-gcp.sh)
#   SIMULATOR_ENABLED=false  ALERT_EMAIL=  SCHEDULE_KIND=rule  ASSUME_YES=1
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-dev}"
REGION="${AWS_REGION:-us-east-1}"

command -v aws >/dev/null || { echo "Instale AWS CLI v2"; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || { echo "Credenciales AWS inválidas o expiradas"; exit 1; }
ARN_TYPE="$(aws sts get-caller-identity --query Arn --output text | cut -d: -f6 | cut -d/ -f1-2)"
LAB_ROLE_ARN="${LAB_ROLE_ARN:-arn:aws:iam::${ACCOUNT}:role/LabRole}"
aws iam get-role --role-name "${LAB_ROLE_ARN##*/}" --query Role.RoleName --output text >/dev/null 2>&1 \
  || echo "AVISO: no se pudo leer el rol ${LAB_ROLE_ARN##*/} (en Academy puede faltar iam:GetRole; continúa)."

echo "Cuenta AWS: $ACCOUNT ($ARN_TYPE) · Región: $REGION · Stage: $STAGE · Rol: ${LAB_ROLE_ARN##*/}"
echo "Recursos con coste por uso: Lambda, API Gateway, DynamoDB on-demand (+PITR), SQS, Step Functions Standard (por transición),"
echo "Secrets Manager (~0.40 USD/mes por secreto), CloudWatch (logs 14 d, alarmas), S3 + CloudFront, SES. Estimación en README."
echo "Simulador programado: ${SIMULATOR_ENABLED:-false} (actívelo sólo durante la demo)."
if [ "${ASSUME_YES:-0}" != "1" ]; then
  read -r -p "¿Desplegar en AWS? (escriba 'si'): " ok
  [ "$ok" = "si" ] || { echo "Cancelado."; exit 1; }
fi

echo "== Build"
( cd "$ROOT" && npm ci --no-audit --no-fund >/dev/null && npm run build -w backend )

PARAMS=(
  "--param=region=$REGION"
  "--param=labRoleArn=$LAB_ROLE_ARN"
  "--param=simulatorEnabled=${SIMULATOR_ENABLED:-false}"
  "--param=scheduleKind=${SCHEDULE_KIND:-rule}"
  "--param=sesFromEmail=${SES_FROM_EMAIL:-}"
  "--param=notifyAllowedRecipients=${NOTIFY_ALLOWED_RECIPIENTS:-}"
  "--param=aiServiceUrl=${AI_SERVICE_URL:-}"
  "--param=aiAuthMode=${AI_AUTH_MODE:-wif}"
  "--param=gcpProjectNumber=${GCP_PROJECT_NUMBER:-}"
  "--param=gcpInvokerSa=${GCP_INVOKER_SA:-}"
  "--param=alertEmail=${ALERT_EMAIL:-}"
  "--param=corsOrigins=${CORS_ORIGINS:-http://localhost:5173}"
)

echo "== Serverless deploy (primera pasada)"
( cd "$ROOT/backend" && npx serverless deploy --stage "$STAGE" --region "$REGION" "${PARAMS[@]}" )

STACK="telecorp-sentinel-$STAGE"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API_URL="$(out HttpApiUrl)"
CF_URL="$(out CloudFrontUrl)"
BUCKET="$(out FrontendBucket)"
DIST_ID="$(out CloudFrontDistributionId)"
echo "API: $API_URL"

if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
  echo "== Frontend -> S3 privado + CloudFront"
  ( cd "$ROOT/frontend" && VITE_API_BASE_URL="$API_URL" npm run build )
  aws s3 sync "$ROOT/frontend/dist" "s3://$BUCKET" --delete --region "$REGION"
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' >/dev/null
  if [ "${CORS_ORIGINS:-}" != "$CF_URL" ]; then
    echo "== Segunda pasada: restringir CORS al dominio de CloudFront ($CF_URL)"
    PARAMS=("${PARAMS[@]/--param=corsOrigins=*/--param=corsOrigins=$CF_URL}")
    ( cd "$ROOT/backend" && npx serverless deploy --stage "$STAGE" --region "$REGION" "${PARAMS[@]}" )
  fi
  echo "Portal: $CF_URL"
fi
echo
echo "Siguiente paso: crear el operador (la contraseña se lee de la variable, no se imprime):"
echo "  OPERATOR_PASSWORD='<elija una>' TABLE_NAME=$(out TableName) AWS_REGION=$REGION SECRET_ARN=$(out SecretArn) npx tsx scripts/create-operator.ts operador.demo"
echo "Smoke test: API_URL=$API_URL npx tsx scripts/smoke-test.ts"
