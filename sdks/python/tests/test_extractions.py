"""Hermetic contract tests for the extraction client surface: extraction schemas, publisher/period
extraction runs, monthly packages, source-schema binding, source-version content, and the
``extraction.*`` webhook subscription — using httpx.MockTransport (no network)."""

import json
import uuid

import httpx
import pytest

from kaval import EXTRACTION_EVENT_TYPES, KavalClient

SCHEMA = {
    "id": "10000000-0000-4000-8000-000000000001",
    "workspace_id": "ws_1",
    "name": "prior-auth-changes",
    "json_schema": {"type": "object"},
    "schema_sha256": "a" * 64,
    "created_at": "2026-08-06T00:00:00.000Z",
}

RUN = {
    "id": "20000000-0000-4000-8000-000000000001",
    "workspace_id": "ws_1",
    "scope": "publisher_period",
    "payer_id": "aetna",
    "period": "2026-08",
    "extraction_schema_id": SCHEMA["id"],
    "status": "processing",
    "attempt_count": 0,
    "created_at": "2026-08-06T00:00:00.000Z",
    "updated_at": "2026-08-06T00:00:00.000Z",
}

PACKAGE = {
    "id": "30000000-0000-4000-8000-000000000001",
    "workspace_id": "ws_1",
    "payer_id": "aetna",
    "period": "2026-08",
    "status": "ready",
    "pdf_href": "https://api.usekaval.com/v1/packages/1.pdf",
    "manifest": {},
    "built_at": "2026-08-06T00:00:10.000Z",
}

SOURCE = {
    "id": "40000000-0000-4000-8000-000000000001",
    "kind": "entity",
    "locator": "Aetna",
    "label": None,
    "intent": "payer policy bulletins",
    "origin": "registered",
    "parent_source_id": None,
    "scope_keys": [],
    "active": True,
    "poll_interval_s": 3600,
    "next_poll_at": None,
    "last_success_at": None,
    "content_sha256": None,
    "extraction_schema_id": SCHEMA["id"],
    "created_at": "2026-08-06T00:00:00.000Z",
}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def refusing_client():
    return make_client(lambda request: pytest.fail(f"unexpected request: {request.url}"))


def test_create_extraction_schema_sends_an_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json={"extraction_schema": SCHEMA})

    with make_client(handler) as c:
        out = c.create_extraction_schema(
            name="prior-auth-changes", json_schema={"type": "object"}
        )

    assert (captured["method"], captured["path"]) == ("POST", "/v1/extraction-schemas")
    assert str(uuid.UUID(captured["key"])) == captured["key"]
    assert captured["body"] == {
        "name": "prior-auth-changes",
        "json_schema": {"type": "object"},
    }
    assert out == SCHEMA


def test_get_and_list_extraction_schemas():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.url.path.endswith(SCHEMA["id"]):
            return httpx.Response(200, json={"extraction_schema": SCHEMA})
        return httpx.Response(200, json={"extraction_schemas": [SCHEMA]})

    with make_client(handler) as c:
        assert c.get_extraction_schema(SCHEMA["id"]) == SCHEMA
        assert c.list_extraction_schemas() == [SCHEMA]

    assert seen == [
        ("GET", f"/v1/extraction-schemas/{SCHEMA['id']}"),
        ("GET", "/v1/extraction-schemas"),
    ]


def test_create_extraction_run_requests_a_publisher_period_run_with_an_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(202, json={"extraction_run": RUN})

    with make_client(handler) as c:
        out = c.create_extraction_run(
            publisher_id="7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22", period="2026-08", extraction_schema_id=SCHEMA["id"]
        )

    assert (captured["method"], captured["path"]) == ("POST", "/v1/extraction-runs")
    assert str(uuid.UUID(captured["key"])) == captured["key"]
    assert captured["body"] == {
        "publisher_id": "7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22",
        "period": "2026-08",
        "extraction_schema_id": SCHEMA["id"],
    }
    assert out["status"] == "processing"


def test_get_and_list_extraction_runs():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.url.path.endswith(RUN["id"]):
            return httpx.Response(200, json={"extraction_run": RUN})
        return httpx.Response(
            200, json={"extraction_runs": [RUN], "next_cursor": None}
        )

    with make_client(handler) as c:
        assert c.get_extraction_run(RUN["id"]) == RUN
        assert c.list_extraction_runs(
            publisher_id="7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22", period_from="2026-01", period_to="2026-08"
        ) == {
            "extraction_runs": [RUN],
            "next_cursor": None,
        }
        assert c.list_extraction_runs(
            expand_document=False, updated_since="2026-03-01T00:00:00.000Z", limit=25
        ) == {
            "extraction_runs": [RUN],
            "next_cursor": None,
        }

    assert seen[0] == ("GET", f"http://test/v1/extraction-runs/{RUN['id']}")
    assert seen[1] == (
        "GET",
        "http://test/v1/extraction-runs?publisher_id=7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22&period_from=2026-01&period_to=2026-08",
    )
    assert "expand_document=false" in seen[2][1]
    assert "updated_since=" in seen[2][1]
    assert "limit=25" in seen[2][1]


def test_get_and_list_extraction_packages():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.url.path.endswith(PACKAGE["id"]):
            return httpx.Response(200, json={"package": PACKAGE})
        return httpx.Response(200, json={"packages": [PACKAGE]})

    with make_client(handler) as c:
        assert c.get_extraction_package(PACKAGE["id"]) == PACKAGE
        assert c.list_extraction_packages(publisher_id="7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22") == [PACKAGE]

    assert seen == [
        ("GET", f"http://test/v1/extraction-packages/{PACKAGE['id']}"),
        ("GET", "http://test/v1/extraction-packages?publisher_id=7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22"),
    ]


def test_update_source_binds_and_unbinds_an_extraction_schema():
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured.append((request.method, request.url.path, body))
        payload: dict = {"source": SOURCE}
        if body.get("reprocess") is True:
            payload["reprocess_queued"] = 3
        return httpx.Response(200, json=payload)

    with make_client(handler) as c:
        out = c.update_source(SOURCE["id"], extraction_schema_id=SCHEMA["id"])
        c.update_source(SOURCE["id"], extraction_schema_id=None)
        reprocessed = c.update_source(
            SOURCE["id"], extraction_schema_id=SCHEMA["id"], reprocess=True
        )

    assert out["extraction_schema_id"] == SCHEMA["id"]
    assert "reprocess_queued" not in out
    assert reprocessed["reprocess_queued"] == 3
    assert captured == [
        ("PATCH", f"/v1/sources/{SOURCE['id']}", {"extraction_schema_id": SCHEMA["id"]}),
        ("PATCH", f"/v1/sources/{SOURCE['id']}", {"extraction_schema_id": None}),
        (
            "PATCH",
            f"/v1/sources/{SOURCE['id']}",
            {"extraction_schema_id": SCHEMA["id"], "reprocess": True},
        ),
    ]


def test_get_source_version_content_defaults_to_plain_text():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/source-versions/ver_1/content"
        assert request.url.query == b""
        return httpx.Response(200, json={"content": "# Prior authorization\n..."})

    with make_client(handler) as c:
        out = c.get_source_version_content("ver_1")

    assert out == {"content": "# Prior authorization\n..."}


def test_get_source_version_content_accepts_sections_format():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/source-versions/ver_1/content"
        assert request.url.query == b"format=sections"
        return httpx.Response(
            200,
            json={
                "sections": [
                    {
                        "index": 0,
                        "heading": "Prior authorization",
                        "start_offset": 0,
                        "end_offset": 42,
                    }
                ]
            },
        )

    with make_client(handler) as c:
        out = c.get_source_version_content("ver_1", format="sections")

    assert out["sections"][0]["heading"] == "Prior authorization"


def test_subscribe_extractions_registers_both_event_types_with_an_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            json={
                "subscription": {"subscription_id": "sub_1"},
                "webhook_verification": {
                    "algorithm": "hmac-sha256",
                    "key_id": "k1",
                    "secret": "s",
                    "signed_content": "id.timestamp.body",
                    "headers": ["webhook-signature"],
                },
            },
        )

    with make_client(handler) as c:
        out = c.subscribe_extractions(
            "https://example.com/hooks/kaval",
            external_scope_ids=["payer:aetna"],
            idempotency_key="webhook-operation-0002",
        )

    assert (captured["method"], captured["path"]) == ("POST", "/v1/webhooks")
    assert captured["key"] == "webhook-operation-0002"
    assert captured["body"] == {
        "subscription_kind": "extraction",
        "callback_url": "https://example.com/hooks/kaval",
        "event_types": list(EXTRACTION_EVENT_TYPES),
        "external_scope_ids": ["payer:aetna"],
    }
    assert out["subscription"]["subscription_id"] == "sub_1"


def test_policy_update_mutations_require_ids_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="source_id is required"):
            c.update_source("  ", extraction_schema_id=None)
        with pytest.raises(ValueError, match="schema_id is required"):
            c.get_extraction_schema("  ")
        with pytest.raises(ValueError, match="run_id is required"):
            c.get_extraction_run("  ")
        with pytest.raises(ValueError, match="package_id is required"):
            c.get_extraction_package("  ")
