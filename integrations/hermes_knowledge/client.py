"""HTTP client for the Hermes Knowledge service (contract v1).

The runtime previously imported the knowledge checkout out of tree on every
request.  This client is the supported integration path: configure
``HERMES_KNOWLEDGE_URL`` + ``HERMES_KNOWLEDGE_TOKEN`` and the runtime talks to
the service over HTTP instead of touching another checkout's files.

Endpoints used (all under ``/api``, bearer auth):

* ``GET  /health``
* ``GET  /captures`` / ``POST /captures``
* ``POST /capture-drafts/{id}/confirmation`` / ``/commit``
* ``POST /reading/drafts/{id}/confirmation`` / ``/commit``
* ``DELETE /knowledge/library/items/{kind}/{id}/permanent``
* ``GET  /knowledge/search``
* ``POST /knowledge/graph/refresh``

Failures are typed so callers can preserve the service's semantics instead of
flattening every error into a 502: 404 -> :class:`KnowledgeNotFound`, 409 ->
:class:`KnowledgeConflict` (carrying the service ``detail`` payload so a
"still referenced" response stays actionable), other 4xx ->
:class:`KnowledgeInvalid`, 5xx / transport errors / invalid configuration ->
:class:`KnowledgeUnavailable`.
"""
from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

SERVICE_NAME = "hermes-knowledge"
MIN_CONTRACT_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 30.0

# Only idempotent reads are retried; POST/DELETE must never be replayed.
_RETRYABLE_METHODS = frozenset({"GET", "HEAD"})
_RETRY_ATTEMPTS = 2
_RETRY_BACKOFF_SECONDS = 0.2


class KnowledgeUnavailable(RuntimeError):
    """The knowledge service is not configured, unreachable, or misbehaving."""


class KnowledgeIncompatible(KnowledgeUnavailable):
    """The service speaks an older/incompatible contract."""


class KnowledgeHttpError(KnowledgeUnavailable):
    """A non-2xx response from the knowledge service."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


class KnowledgeNotFound(KnowledgeHttpError):
    """HTTP 404 — the addressed object does not exist."""


class KnowledgeConflict(KnowledgeHttpError):
    """HTTP 409 — the object is still referenced or otherwise in conflict."""


class KnowledgeInvalid(KnowledgeHttpError):
    """Another HTTP 4xx — the request itself was rejected."""


@dataclass(frozen=True)
class KnowledgeConfig:
    base_url: str
    token: str = ""
    timeout: float = DEFAULT_TIMEOUT_SECONDS


def _parse_timeout(raw: str | None) -> float:
    """Parse ``HERMES_KNOWLEDGE_TIMEOUT`` into seconds.

    A bare ``float()`` used to raise ``ValueError`` for values like ``"30s"``,
    which surfaced as a 500 from the web route.  Bad input is configuration
    error, not a server crash, so it raises :class:`KnowledgeUnavailable`.
    """
    if raw is None or not str(raw).strip():
        return DEFAULT_TIMEOUT_SECONDS
    try:
        timeout = float(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_TIMEOUT must be a number of seconds "
            f"(e.g. 30), got {raw!r}"
        ) from exc
    if timeout <= 0:
        raise KnowledgeUnavailable(
            f"HERMES_KNOWLEDGE_TIMEOUT must be positive, got {raw!r}"
        )
    return timeout


def _normalize_base_url(raw: str) -> str:
    """Validate ``HERMES_KNOWLEDGE_URL`` and strip a trailing slash."""
    value = str(raw or "").strip().rstrip("/")
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_URL must be an absolute http(s) URL "
            f"(e.g. http://127.0.0.1:8001), got {raw!r}"
        )
    if parts.path or parts.query or parts.fragment:
        raise KnowledgeUnavailable(
            "HERMES_KNOWLEDGE_URL must not include a path, query or fragment "
            f"(the client appends /api itself), got {raw!r}"
        )
    return value


def load_config() -> KnowledgeConfig | None:
    base_url = (os.environ.get("HERMES_KNOWLEDGE_URL") or "").strip()
    if not base_url:
        return None
    return KnowledgeConfig(
        base_url=_normalize_base_url(base_url),
        token=(os.environ.get("HERMES_KNOWLEDGE_TOKEN") or "").strip(),
        timeout=_parse_timeout(os.environ.get("HERMES_KNOWLEDGE_TIMEOUT")),
    )


class KnowledgeClient:
    def __init__(self, config: KnowledgeConfig, *, transport: httpx.BaseTransport | None = None):
        self._config = config
        headers = {"User-Agent": "hermes-agent/knowledge-client"}
        if config.token:
            headers["Authorization"] = f"Bearer {config.token}"
        # trust_env=False: a local HTTP(S)_PROXY must never receive the bearer
        # token meant for the knowledge service (which is often on loopback).
        self._client = httpx.Client(
            base_url=config.base_url,
            headers=headers,
            timeout=config.timeout,
            transport=transport,
            trust_env=False,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "KnowledgeClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    # -- transport helpers ---------------------------------------------------
    @staticmethod
    def _error_detail(response: httpx.Response) -> Any:
        """Best-effort error body extraction — never raises."""
        try:
            return response.json()
        except (TypeError, ValueError):
            pass
        try:
            text = (response.text or "").strip()
        except Exception:  # noqa: BLE001 - decoding failure is not fatal here
            text = ""
        return text[:300] or f"HTTP {response.status_code}"

    def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Send a request, retrying idempotent reads once on transient failure."""
        method = method.upper()
        attempts = _RETRY_ATTEMPTS if method in _RETRYABLE_METHODS else 1
        last_exc: httpx.HTTPError | None = None
        for attempt in range(attempts):
            try:
                response = self._client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                last_exc = exc
                if attempt + 1 < attempts:
                    time.sleep(_RETRY_BACKOFF_SECONDS)
                    continue
                raise KnowledgeUnavailable(
                    f"knowledge request {method} {path} failed: {exc}"
                ) from exc
            if (
                method in _RETRYABLE_METHODS
                and response.status_code >= 500
                and attempt + 1 < attempts
            ):
                time.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            return response
        # Defensive: the loop always returns or raises above.
        if last_exc is not None:
            raise last_exc
        raise KnowledgeUnavailable(f"knowledge request {method} {path} failed")

    def _raise_for_status(self, response: httpx.Response, method: str, path: str) -> None:
        status = int(response.status_code)
        if status < 400:
            return
        detail = self._error_detail(response)
        message = f"knowledge request {method} {path} -> HTTP {status}: {detail}"
        if status == 404:
            raise KnowledgeNotFound(message, status_code=status, detail=detail)
        if status == 409:
            raise KnowledgeConflict(message, status_code=status, detail=detail)
        if status < 500:
            raise KnowledgeInvalid(message, status_code=status, detail=detail)
        raise KnowledgeUnavailable(message)

    @staticmethod
    def _json_payload(response: httpx.Response, method: str, path: str) -> Any:
        if not response.content:
            return {}
        try:
            return response.json()
        except (TypeError, ValueError) as exc:
            raise KnowledgeUnavailable(
                f"non-JSON response from knowledge {method} {path} "
                f"(HTTP {response.status_code})"
            ) from exc

    # -- contract ------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        response = self._send("GET", "/api/health")
        if response.status_code != 200:
            raise KnowledgeUnavailable(
                f"knowledge health check failed with HTTP {response.status_code}"
            )
        payload = self._json_payload(response, "GET", "/api/health")
        if not isinstance(payload, dict):
            raise KnowledgeUnavailable(
                "non-JSON response from knowledge GET /api/health "
                f"(HTTP {response.status_code})"
            )
        if payload.get("service") != SERVICE_NAME:
            raise KnowledgeIncompatible(
                f"unexpected service: {payload.get('service')!r}"
            )
        return payload

    def assert_compatible(self) -> dict[str, Any]:
        health = self.health()
        try:
            version = int(health.get("contract_version") or 0)
        except (TypeError, ValueError):
            version = 0
        if version < MIN_CONTRACT_VERSION:
            raise KnowledgeIncompatible(
                f"knowledge contract v{version} < required v{MIN_CONTRACT_VERSION}"
            )
        return health

    # -- operations ----------------------------------------------------------
    def request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        response = self._send(method, path, **kwargs)
        self._raise_for_status(response, method, path)
        if response.status_code >= 300:
            # httpx does not follow redirects by default; a 3xx here means the
            # endpoint answered with something other than the JSON contract.
            raise KnowledgeUnavailable(
                f"non-JSON response from knowledge {method} {path} "
                f"(HTTP {response.status_code} redirect is not followed)"
            )
        return self._json_payload(response, method, path)

    def issue_confirmation(self, resource: str, resource_id: str) -> dict[str, Any]:
        """``resource`` is e.g. ``capture-drafts`` or ``reading/drafts``."""
        return self.request("POST", f"/api/{resource}/{resource_id}/confirmation")

    def commit_draft(self, resource: str, resource_id: str, confirmation_token: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/{resource}/{resource_id}/commit",
            json={"confirmation_token": confirmation_token},
        )

    def issue_library_delete_confirmation(self, kind: str, item_id: str) -> dict[str, Any]:
        """Ask the service for a permanent-delete confirmation token.

        Accepts both response shapes the service has shipped (``token`` and
        ``confirmation_token``) and normalises the value under ``token`` so
        callers do not depend on the wire spelling.
        """
        payload = self.request(
            "POST", f"/api/knowledge/library/items/{kind}/{item_id}/confirmation"
        )
        if not isinstance(payload, dict):
            payload = {}
        token = str(payload.get("token") or payload.get("confirmation_token") or "").strip()
        if not token:
            raise KnowledgeUnavailable(
                "knowledge service did not return a permanent-delete "
                "confirmation token"
            )
        normalized = dict(payload)
        normalized["token"] = token
        return normalized

    def permanent_delete_library_item(
        self, kind: str, item_id: str, confirmation_token: str
    ) -> dict[str, Any]:
        token = str(confirmation_token or "").strip()
        if not token:
            # Never send a blank confirmation token: the service would either
            # reject it (mapped to a confusing 502) or, worse, accept it.
            raise KnowledgeUnavailable(
                "refusing to request a permanent delete without a "
                "confirmation token"
            )
        return self.request(
            "DELETE",
            f"/api/knowledge/library/items/{kind}/{item_id}/permanent",
            json={"confirmation_token": token},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )

    def search(self, query: str, *, limit: int = 10) -> dict[str, Any]:
        return self.request("GET", "/api/knowledge/search", params={"q": query, "limit": limit})


def get_client(transport: httpx.BaseTransport | None = None) -> KnowledgeClient | None:
    """Return a configured client, or None when HTTP mode is not configured."""
    config = load_config()
    if config is None:
        return None
    return KnowledgeClient(config, transport=transport)
