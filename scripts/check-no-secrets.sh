#!/usr/bin/env bash
# Escaneo simple de secretos/material privado en los archivos versionados (o por versionar).
# Falla si encuentra patrones de credenciales, claves privadas, tokens JWT, o archivos prohibidos.
set -uo pipefail
cd "$(dirname "$0")/.."
FILES=$(git ls-files -co --exclude-standard)
fail=0
check() { local desc="$1" pat="$2"; local hits; hits=$(grep -lIE "$pat" $FILES 2>/dev/null | grep -v '^scripts/check-no-secrets.sh$' || true); if [ -n "$hits" ]; then echo "PROHIBIDO ($desc): $hits"; fail=1; fi; }
check "AWS access key" 'AKIA[0-9A-Z]{16}'
check "AWS secret" 'aws_secret_access_key|aws_session_token'
check "clave privada" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "JWT" 'eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
check "clave de cuenta de servicio GCP" '"private_key_id"'
check "prompt maestro" 'PROMPT MAESTRO'
bad=$(echo "$FILES" | grep -iE '(^|/)\.env$|\.env\.local$|\.pem$|\.key$|\.pdf$|\.zip$|\.docx$|credentials|service-account.*\.json$|^\.local/' || true)
[ -n "$bad" ] && { echo "ARCHIVOS PROHIBIDOS: $bad"; fail=1; }
[ $fail -eq 0 ] && echo "Sin secretos ni material privado detectado." || exit 1
