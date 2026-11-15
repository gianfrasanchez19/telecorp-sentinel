"""Verifica que el modelo Gemini configurado responde en Vertex AI ANTES de desplegar.

No inventa IDs de modelo: usted elige uno que aparezca disponible para su proyecto y
región en la consola de Vertex AI (Model Garden) y lo prueba aquí.

Uso (con credenciales locales de gcloud: gcloud auth application-default login):
  GOOGLE_CLOUD_PROJECT=mi-proyecto VERTEX_LOCATION=us-central1 GEMINI_MODEL=<modelo> \
    python ai-service/scripts/check_model.py
"""

import os
import sys
import time

from google import genai
from google.genai import types


def main() -> int:
    model = os.environ.get("GEMINI_MODEL")
    if not model:
        print("Defina GEMINI_MODEL")
        return 2
    client = genai.Client(vertexai=True, project=os.environ["GOOGLE_CLOUD_PROJECT"], location=os.environ.get("VERTEX_LOCATION", "us-central1"))
    t = time.perf_counter()
    try:
        r = client.models.generate_content(model=model, contents="Responde solo: OK", config=types.GenerateContentConfig(max_output_tokens=5, temperature=0))
    except Exception as exc:  # noqa: BLE001
        print(f"Modelo NO disponible o sin permisos: {type(exc).__name__}: {exc}")
        return 1
    print(f"Modelo '{model}' respondió en {int((time.perf_counter() - t) * 1000)} ms: {(r.text or '').strip()!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
