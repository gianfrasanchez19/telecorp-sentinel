#!/usr/bin/env bash
# Elimina el stack de AWS. La tabla DynamoDB tiene DeletionPolicy=Retain (protege el
# historial): se informa y se ofrece borrarla aparte. Pide confirmación explícita.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-dev}"; REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
STACK="telecorp-sentinel-$STAGE"
echo "Cuenta $ACCOUNT · stack $STACK · región $REGION"
read -r -p "Escriba 'eliminar' para borrar el stack (Lambdas, API, colas, Step Functions, CloudFront, S3, alarmas): " ok
[ "$ok" = "eliminar" ] || { echo "Cancelado."; exit 1; }
BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='FrontendBucket'].OutputValue" --output text 2>/dev/null || true)"
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] && aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" || true
( cd "$ROOT/backend" && npx serverless remove --stage "$STAGE" --region "$REGION" --param="labRoleArn=arn:aws:iam::${ACCOUNT}:role/LabRole" )
echo "La tabla telecorp-sentinel-$STAGE se conservó (Retain). Para borrarla definitivamente (irreversible):"
echo "  aws dynamodb delete-table --table-name telecorp-sentinel-$STAGE --region $REGION"
echo "El secreto queda en borrado programado (7-30 días) según Secrets Manager."
