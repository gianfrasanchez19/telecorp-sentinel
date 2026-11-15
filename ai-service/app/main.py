"""TeleCorp Sentinel — microservicio de IA (Google Cloud Run + Vertex AI Gemini)."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .analyzer import ModelClient, VertexGeminiClient, build_prompt, parse_output
from .schemas import AnalyzeRequest, AnalyzeResponse
from .security import AuthError, NonceCache, verify_hmac, verify_invoker

MAX_BODY = 16_000

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
logger = logging.getLogger("ai-service")


def log(tipo: str, evento: str, **datos: object) -> None:
    """Formato estándar del curso: {tipo, log_datos}. Sin PII."""
    logger.info(json.dumps({"tipo": tipo, "log_datos": {"evento": evento, **datos}}, ensure_ascii=False))


app = FastAPI(title="TeleCorp Sentinel AI", docs_url=None, redoc_url=None, openapi_url=None)
_nonces = NonceCache()
_client: ModelClient | None = None


def get_client() -> ModelClient:
    global _client
    if _client is None:
        _client = VertexGeminiClient()
    return _client


def set_client(c: ModelClient | None) -> None:
    global _client
    _client = c


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/v1/analyze")
async def analyze(request: Request) -> JSONResponse:
    raw = await request.body()
    req_id = request.headers.get("x-request-id", "-")[:120]
    if len(raw) > MAX_BODY:
        return JSONResponse({"error": "payload demasiado grande"}, status_code=413)
    mode = os.environ.get("AUTH_MODE", "iam")
    try:
        if mode == "hmac":
            secret = os.environ.get("AI_HMAC_KEY", "")
            if not secret:
                raise AuthError("Servicio mal configurado")
            verify_hmac(raw, {k.lower(): v for k, v in request.headers.items()}, bytes.fromhex(secret.strip()), _nonces)
        else:
            verify_invoker(request.headers.get("authorization"), os.environ.get("ALLOWED_INVOKER", ""))
    except AuthError as exc:
        log("WARN", "auth_rechazada", requestId=req_id, motivo=str(exc))
        return JSONResponse({"error": "no autorizado"}, status_code=401)

    try:
        body = AnalyzeRequest.model_validate_json(raw)
    except ValidationError:
        return JSONResponse({"error": "entrada inválida"}, status_code=400)

    started = time.perf_counter()
    client = get_client()
    try:
        text, usage = client.generate(build_prompt(body.context))
    except Exception as exc:  # noqa: BLE001 — errores del proveedor => 503 (el backend reintenta / usa respaldo)
        log("ERROR", "modelo_error", requestId=body.requestId, error=type(exc).__name__)
        return JSONResponse({"error": "modelo no disponible"}, status_code=503)
    try:
        out = parse_output(text)
    except (ValueError, ValidationError):
        log("ERROR", "salida_invalida", requestId=body.requestId)
        return JSONResponse({"error": "salida del modelo inválida"}, status_code=422)
    latency = int((time.perf_counter() - started) * 1000)
    resp = AnalyzeResponse(
        **out.model_dump(),
        model=client.model_id,
        generatedAt=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        requestId=body.requestId,
        latencyMs=latency,
    )
    log("INFO", "analisis_ok", requestId=body.requestId, model=client.model_id, latencyMs=latency, **usage)
    return JSONResponse(resp.model_dump())
