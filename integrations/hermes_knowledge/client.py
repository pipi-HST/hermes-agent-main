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
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

SERVICE_NAME = "hermes-knowledge"
MIN_CONTRACT_VERSION = 1


class KnowledgeUnavailable(RuntimeError):
    """The knowledge service is not configured or unreachable."""


class KnowledgeIncompatible(KnowledgeUnavailable):
    """The service speaks an older/incompatible contract."""


@dataclass(frozen=True)
class KnowledgeConfig:
    base_url: str
    token: str = ""
    timeout: float = 30.0


def load_config() -> KnowledgeConfig | None:
    base_url = (os.environ.get("HERMES_KNOWLEDGE_URL") or "").strip()
    if not base_url:
        return None
    return KnowledgeConfig(
        base_url=base_url.rstrip("/"),
        token=(os.environ.get("HERMES_KNOWLEDGE_TOKEN") or "").strip(),
        timeout=float(os.environ.get("HERMES_KNOWLEDGE_TIMEOUT") or 30.0),
    )


class KnowledgeClient:
    def __init__(self, config: KnowledgeConfig, *, transport: httpx.BaseTransport | None = None):
        self._config = config
        headers = {"User-Agent": "hermes-agent/knowledge-client"}
        if config.token:
            headers["Authorization"] = f"Bearer {config.token}"
        self._client = httpx.Client(
            base_url=config.base_url,
            headers=headers,
            timeout=config.timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "KnowledgeClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    # -- contract ------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        try:
            response = self._client.get("/api/health")
        except httpx.HTTPError as exc:
            raise KnowledgeUnavailable(f"knowledge service unreachable: {exc}") from exc
        if response.status_code != 200:
            raise KnowledgeUnavailable(
                f"knowledge health check failed with HTTP {response.status_code}"
            )
        payload = response.json()
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
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise KnowledgeUnavailable(f"knowledge request failed: {exc}") from exc
        if response.status_code >= 400:
            detail: Any
            try:
                detail = response.json()
            except ValueError:
                detail = response.text[:300]
            raise KnowledgeUnavailable(
                f"knowledge request {method} {path} -> {response.status_code}: {detail}"
            )
        if not response.content:
            return {}
        return response.json()

    def issue_confirmation(self, resource: str, resource_id: str) -> dict[str, Any]:
        """``resource`` is e.g. ``capture-drafts`` or ``reading/drafts``."""
        return self.request("POST", f"/api/{resource}/{resource_id}/confirmation")

    def commit_draft(self, resource: str, resource_id: str, confirmation_token: str) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/{resource}/{resource_id}/commit",
            json={"confirmation_token": confirmation_token},
        )

    def permanent_delete(self, kind: str, item_id: str, confirmation_token: str) -> dict[str, Any]:
        return self.request(
            "DELETE",
            f"/api/knowledge/library/items/{kind}/{item_id}/permanent",
            json={"confirmation_token": confirmation_token},
        )

    def search(self, query: str, *, limit: int = 10) -> dict[str, Any]:
        return self.request("GET", "/api/knowledge/search", params={"q": query, "limit": limit})


def get_client(transport: httpx.BaseTransport | None = None) -> KnowledgeClient | None:
    """Return a configured client, or None when HTTP mode is not configured."""
    config = load_config()
    if config is None:
        return None
    return KnowledgeClient(config, transport=transport)
