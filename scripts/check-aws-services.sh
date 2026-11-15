#!/usr/bin/env bash
# Comprobación de SOLO LECTURA (sin coste) de los servicios y permisos que usa
# TeleCorp Sentinel en la cuenta actual (pensado para AWS Academy Learner Lab).
# No crea ni modifica nada. Uso: AWS_REGION=us-east-1 bash scripts/check-aws-services.sh
set -uo pipefail
REGION="${AWS_REGION:-us-east-1}"
ok() { printf "  \033[32mOK\033[0m   %s\n" "$1"; }
ko() { printf "  \033[31mNO\033[0m   %s  -> %s\n" "$1" "$2"; }
try() { local name="$1" hint="$2"; shift 2; if "$@" >/dev/null 2>&1; then ok "$name"; else ko "$name" "$hint"; fi; }

command -v aws >/dev/null || { echo "Instale AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || { echo "Sin credenciales válidas (¿expiró la sesión de AWS Academy?)."; exit 1; }
WHO="$(aws sts get-caller-identity --query Arn --output text | sed -E 's#^arn:aws:(sts|iam)::[0-9]+:##')"
echo "Cuenta $ACCOUNT · identidad $WHO · región $REGION"
echo "Servicios (sólo lectura):"
try "Lambda" "requerido" aws lambda list-functions --max-items 1 --region "$REGION"
try "API Gateway v2 (HTTP API)" "requerido" aws apigatewayv2 get-apis --max-results 1 --region "$REGION"
try "DynamoDB" "requerido" aws dynamodb list-tables --max-items 1 --region "$REGION"
try "SQS" "requerido" aws sqs list-queues --max-results 1 --region "$REGION"
try "Step Functions" "requerido (rúbrica)" aws stepfunctions list-state-machines --max-results 1 --region "$REGION"
try "Secrets Manager" "requerido (rúbrica: secretos en AWS)" aws secretsmanager list-secrets --max-results 1 --region "$REGION"
try "CloudFormation" "requerido (Serverless)" aws cloudformation list-stacks --max-items 1 --region "$REGION"
try "S3" "requerido (artefactos y frontend)" aws s3api list-buckets
try "CloudWatch" "alarmas" aws cloudwatch describe-alarms --max-records 1 --region "$REGION"
try "CloudWatch Logs" "logs" aws logs describe-log-groups --limit 1 --region "$REGION"
try "EventBridge (reglas)" "simulador (scheduleKind=rule)" aws events list-rules --limit 1 --region "$REGION"
try "EventBridge Scheduler" "opcional: si NO, use scheduleKind=rule" aws scheduler list-schedules --max-results 1 --region "$REGION"
try "CloudFront" "si NO: deployFrontend=false y sirva el frontend en local" aws cloudfront list-distributions --max-items 1
try "SNS" "alertas" aws sns list-topics --region "$REGION"
try "X-Ray" "si NO: tracing=false" aws xray get-sampling-rules --region "$REGION"
if aws sesv2 get-account --region "$REGION" >/dev/null 2>&1; then
  PROD="$(aws sesv2 get-account --region "$REGION" --query ProductionAccessEnabled --output text)"
  ok "SES (ProductionAccessEnabled=$PROD; si es False => sandbox: sólo destinatarios verificados)"
  echo "       Identidades: $(aws sesv2 list-email-identities --region "$REGION" --query 'length(EmailIdentities)' --output text) registradas"
else ko "SES" "sin correo real: las notificaciones quedarán OMITIDAS (registradas, sin enviar)"; fi
CONC="$(aws lambda get-account-settings --region "$REGION" --query AccountLimit.ConcurrentExecutions --output text 2>/dev/null || echo '?')"
echo "  INFO Concurrencia de Lambda de la cuenta: $CONC (si es baja, mantenga eventsMaxConcurrency<=5)"
if aws iam get-role --role-name LabRole >/dev/null 2>&1; then
  TRUST="$(aws iam get-role --role-name LabRole --query 'Role.AssumeRolePolicyDocument.Statement[].Principal.Service' --output text | tr '\t' ' ')"
  ok "LabRole existe"
  for svc in lambda.amazonaws.com states.amazonaws.com scheduler.amazonaws.com; do
    [[ " $TRUST " == *" $svc "* ]] && ok "LabRole confiable para $svc" || ko "LabRole confiable para $svc" "si falta scheduler: scheduleKind=rule"
  done
else ko "LabRole (iam:GetRole)" "en cuentas no-Academy cree infra/aws/iam-roles.yml"; fi
echo "Listo (no se creó ningún recurso)."
