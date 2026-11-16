#!/usr/bin/env bash
# Compatibilidad con Git Bash en Windows: el wrapper bash de gcloud falla por la
# conversión de rutas de MSYS ("C:\...\Cloud SDK" con espacios). Si estamos en
# MINGW/MSYS y gcloud no responde, se invoca gcloud.py con el Python incluido en el SDK.
if ! gcloud --version >/dev/null 2>&1; then
  for sdk in "${CLOUDSDK_ROOT:-}" "$LOCALAPPDATA/Google/Cloud SDK/google-cloud-sdk" "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk" "/c/Program Files/Google/Cloud SDK/google-cloud-sdk"; do
    [ -n "$sdk" ] && [ -f "$sdk/lib/gcloud.py" ] || continue
    _GC_SDK="$(cd "$sdk" && pwd -W 2>/dev/null || echo "$sdk")"
    if [ -f "$sdk/platform/bundledpython/python.exe" ]; then _GC_PY="$_GC_SDK/platform/bundledpython/python.exe"; else _GC_PY="python"; fi
    gcloud() { MSYS_NO_PATHCONV=1 "$_GC_PY" "$_GC_SDK/lib/gcloud.py" "$@"; }
    break
  done
fi
gcloud --version >/dev/null 2>&1 || { echo "No se encontró Google Cloud CLI (gcloud). Instálelo: https://cloud.google.com/sdk/docs/install"; exit 1; }
