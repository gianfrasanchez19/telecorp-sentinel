"""Autenticación del servicio de IA.

Modo principal ``iam``: Cloud Run se despliega PRIVADO (--no-allow-unauthenticated);
Google valida el ID token antes de que la petición llegue al contenedor. Como
defensa en profundidad verificamos que el ``email`` del token (ya validado por
Cloud Run) coincida con la cuenta de servicio invocadora esperada.

Modo alternativo ``hmac`` (sólo si WIF no es posible): firma HMAC-SHA256 del cuerpo
crudo + timestamp + nonce, con ventana de 5 minutos y protección de replay.
El secreto vive en GCP Secret Manager (inyectado por Cloud Run como variable).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time

MAX_SKEW_SECONDS = 300


class AuthError(Exception):
    pass


class NonceCache:
    """Cache de nonces vistos (por instancia). Con HMAC se despliega max-instances=1."""

    def __init__(self, ttl: int = MAX_SKEW_SECONDS * 2, max_items: int = 50_000) -> None:
        self._seen: dict[str, float] = {}
        self._ttl = ttl
        self._max = max_items
        self._lock = threading.Lock()

    def check_and_add(self, nonce: str, now: float) -> bool:
        with self._lock:
            if len(self._seen) > self._max:
                self._seen = {k: v for k, v in self._seen.items() if v > now - self._ttl}
            if nonce in self._seen and self._seen[nonce] > now - self._ttl:
                return False
            self._seen[nonce] = now
            return True


def verify_hmac(raw_body: bytes, headers: dict[str, str], secret: bytes, nonces: NonceCache, now: float | None = None) -> None:
    now = time.time() if now is None else now
    ts = headers.get("x-sentinel-timestamp", "")
    nonce = headers.get("x-sentinel-nonce", "")
    sig = headers.get("x-sentinel-signature", "")
    if not ts.isdigit() or not nonce or len(nonce) > 64 or not sig:
        raise AuthError("Cabeceras de firma ausentes")
    if abs(now - int(ts)) > MAX_SKEW_SECONDS:
        raise AuthError("Firma expirada")
    body_hash = hashlib.sha256(raw_body).hexdigest()
    expected = hmac.new(secret, f"{ts}.{nonce}.{body_hash}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise AuthError("Firma inválida")
    if not nonces.check_and_add(nonce, now):
        raise AuthError("Replay detectado")


def verify_invoker(authorization: str | None, expected_email: str) -> None:
    """Cloud Run ya verificó la firma del ID token; aquí sólo comprobamos el invocador."""
    if not expected_email:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise AuthError("Falta token de identidad")
    try:
        payload_b64 = authorization[7:].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    except Exception as exc:  # noqa: BLE001
        raise AuthError("Token mal formado") from exc
    if payload.get("email") != expected_email:
        raise AuthError("Invocador no autorizado")
