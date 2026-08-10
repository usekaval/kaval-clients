"""Hermetic contract tests: assert the client serializes requests + parses responses correctly,
using httpx.MockTransport (no network)."""

import json
import re
import uuid
from pathlib import Path
from typing import Literal, get_args, get_type_hints

import httpx
import pytest
from typing_extensions import NotRequired

import kaval
from kaval import (
    FACT_STATE_DELTA_EVENT_TYPE,
    KavalCancellationToken,
    KavalCancelledError,
    KavalClient,
    KavalError,
    KavalRetiredError,
    VerifyReceipt,
)
from kaval.client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT_SECONDS, NO_TIMEOUT
from kaval.models import (
    CalibrationSupportIdentity,
    CheckReasonCode,
    CheckReceiptBasis,
    CheckVerdict,
    ClaimAssessment,
    FactStatus,
    WatchedSource,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parents[3] / "fixtures"

# The representative /v1/verify success envelope: {status, receipt{..., packet}} with an
# Ed25519-signed packet. Receipt-level expiry deliberately does not exist — it lives at
# receipt.packet.action_decision.expires_at.
VERIFY_RESULT = json.loads((FIXTURES / "py-verify-result-v1.json").read_text())

# The representative POST /v1/check response.
CHECK_RESULT = {
    "decision": "BLOCK",
    "reason_codes": ["FACT_CHANGED"],
    "facts": [
        {
            "fingerprint": "fact:sha256:1111",
            "text": "Aetna requires prior authorization for CPT 12345",
            "status": "changed",
            "materiality": "critical",
            "served_from_state": True,
            "last_verified_at": "2026-07-25T09:00:00.000Z",
            "sources": [{"locator": "https://aetna.com/bulletins/2026-07"}],
        }
    ],
    "receipt": {
        "id": "rcpt_1",
        "signature": "c2ln",
        "signed_at": "2026-07-26T00:00:00.000Z",
    },
    "latency_ms": {"compile": 1, "lookup": 8, "live": 0, "total": 11},
}

# The server emits label/intent/parent_source_id UNCONDITIONALLY and nullable
# (`watchedSourceView`), so a fixture that omits them encodes a shape the API never sends.
SOURCE = {
    "id": "src_1",
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
    "created_at": "2026-07-26T00:00:00.000Z",
}

RETIRED_BODY = {"error": "tool_retired", "replacement": "/v1/check"}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def refusing_client():
    return make_client(
        lambda request: pytest.fail(f"unexpected request: {request.url}")
    )


# ---------------------------------------------------------------------------
# Model-shape guarantees
# ---------------------------------------------------------------------------


def test_proof_models_retain_required_calibration_support_identity():
    assert "calibration_support" in ClaimAssessment.__required_keys__
    assert CalibrationSupportIdentity.__required_keys__ == {
        "feature_schema_version",
        "feature_schema_hash",
        "support_fingerprint",
        "feature_vector",
    }


def test_verify_receipt_model_has_no_receipt_level_expiry():
    assert VerifyReceipt.__required_keys__ == {
        "proof_id",
        "decision",
        "reason",
        "share_endpoint",
        "packet",
    }
    assert "expires_at" not in VerifyReceipt.__annotations__


def test_watched_source_label_intent_and_parent_are_required_and_nullable():
    # The server always emits these three keys and they are usually null. Typed NotRequired[str],
    # source["label"].upper() type-checked clean and raised AttributeError on the common case.
    hints = get_type_hints(WatchedSource, include_extras=True)
    for field in ("label", "intent", "parent_source_id"):
        assert hints[field] == (str | None), field


def test_check_receipt_basis_publishes_the_offline_verifier_discriminators():
    # A PDF's canonical text and its raw bytes are two unequal legitimate digests; without these
    # a holder cannot know which artifact version_sha256 covers, and the field is decorative.
    hints = get_type_hints(CheckReceiptBasis, include_extras=True)
    assert hints["version_sha256_of"] == NotRequired[
        Literal["canonical_text", "raw_bytes"]
    ]
    assert hints["parser_name"] == NotRequired[str]
    assert hints["parser_version"] == NotRequired[str]


def test_package_exports_the_wire_types_a_caller_annotates_with():
    # These are the types a caller writes into their own signatures; the Node SDK exports every
    # one of them at the package root, and Python omitted them.
    for export in (
        "ActionDisposition",
        "ActionReversibility",
        "CheckFreshnessFailure",
        "CheckLatency",
        "CheckReceiptBasis",
        "CheckReceiptFact",
        "CheckSourceRef",
        "FactBasisRef",
        "FactStateTransition",
        "Materiality",
        "RecompileSourceResult",
        "WatchedSourceOrigin",
    ):
        assert export in kaval.__all__
        assert getattr(kaval, export) is not None


def test_check_models_match_the_wire_contract():
    assert set(get_args(CheckVerdict)) == {"ALLOW", "REVIEW", "BLOCK"}
    assert set(get_args(FactStatus)) == {"holds", "changed", "unknown"}
    # The closed eight-code taxonomy — no synonyms, no free text.
    assert set(get_args(CheckReasonCode)) == {
        "ALL_FACTS_HOLD",
        "FACT_CHANGED",
        "FACT_EXPIRED",
        "FACT_UNKNOWN",
        "SOURCE_UPDATED_PENDING_REVIEW",
        "SOURCE_UNREACHABLE",
        "NEW_FACT_UNVERIFIED",
        "COMPILATION_UNCERTAIN",
    }
    assert FACT_STATE_DELTA_EVENT_TYPE == "fact_state.delta"


def test_the_published_check_budget_is_the_one_the_engine_runs():
    # The docs kept "defaults to 3000, max 15000" long after the engine moved to 100000, so the
    # copy-paste path handed a first-time caller the exact failure the change removed: every fact
    # back as `unknown`, no basis, no verdict worth reading.
    for relative in ("README.md", "kaval/models.py"):
        text = (PACKAGE_ROOT / relative).read_text(encoding="utf-8")
        assert re.search(r"(?i)defaults?\s+(to\s+)?3000", text) is None, relative
        assert re.search(r"(?i)max(imum)?\s+15000", text) is None, relative
        assert "100000" in text, relative


def test_the_readme_does_not_republish_the_claims_the_server_refutes():
    text = (PACKAGE_ROOT / "README.md").read_text(encoding="utf-8")
    # Every SUCCESSFUL check is metered (kind:"check", billedUnits:1). What verify() alone does is
    # spend an operation key — being unbilled and being unreplayed are not the same claim.
    assert "one remaining billable route" not in text
    assert re.search(r"(?i)everything else\s*—\s*checks,", text) is None
    assert "spends an operation key" in text
    # "Every method accepts a cancellation token" was false for health(), which was also the call
    # most likely to be aimed at a host that never answers.
    assert "Every method accepts a thread-safe" not in text


def test_retired_surface_is_gone():
    for method in (
        "audit",
        "gate",
        "gate_action",
        "legacy_verify_belief",
        "extract_and_check",
        "scan_store",
        "monitor",
        "kaval",
        "kaval_batch",
        # the removed commerce surface must never come back either
        "research_products",
        "search_offers",
        "gate_offer_search",
    ):
        assert not hasattr(KavalClient, method)
    for export in (
        "KavalProofNotFoundError",
        "AuditInput",
        "ProofGateInput",
        "ProofGateResult",
        "ProductResearchInput",
    ):
        assert not hasattr(kaval, export)
        assert export not in kaval.__all__


# ---------------------------------------------------------------------------
# check() — the one call
# ---------------------------------------------------------------------------


def test_check_posts_the_action_body_with_bearer_auth_and_no_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/check"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["authorization"] == "Bearer kv_live_abc"
        captured["idempotency_key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=CHECK_RESULT)

    with KavalClient(
        base_url="http://test",
        api_key="kv_live_abc",
        transport=httpx.MockTransport(handler),
    ) as c:
        result = c.check(
            action="Approve the claim at the current rate", context="payer: Aetna"
        )

    assert captured["body"] == {
        "action": "Approve the claim at the current rate",
        "context": "payer: Aetna",
    }
    # A check is a read of current state: the server does not replay it, so no key is spent.
    assert captured["idempotency_key"] is None
    assert result["decision"] == "BLOCK"
    assert result["reason_codes"] == ["FACT_CHANGED"]
    assert result["facts"][0]["status"] == "changed"
    assert result["facts"][0]["served_from_state"] is True
    assert result["receipt"]["id"] == "rcpt_1"
    assert result["latency_ms"]["total"] == 11


def test_check_sends_structured_claims_verbatim_and_omits_none():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={**CHECK_RESULT, "decision": "ALLOW"})

    with make_client(handler) as c:
        result = c.check(
            claims=[
                {
                    "subject": "Aetna",
                    "predicate": "requires_prior_auth_for",
                    "object": "CPT 12345",
                },
                "The 2024 IBC is the current edition",
            ],
            mode="fast",
            max_wait_ms=None,
        )

    assert captured["body"] == {
        "claims": [
            {
                "subject": "Aetna",
                "predicate": "requires_prior_auth_for",
                "object": "CPT 12345",
            },
            "The 2024 IBC is the current edition",
        ],
        "mode": "fast",
    }
    assert result["decision"] == "ALLOW"


def test_check_serializes_every_optional_field_exactly():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=CHECK_RESULT)

    with make_client(handler) as c:
        c.check(
            action="Ship the order under the current tariff",
            context="HTS 8471.30",
            mode="standard",
            max_wait_ms=5000,
            origin_urls=["https://hts.usitc.gov/"],
            materiality="critical",
            as_of="2026-07-26T00:00:00+00:00",
        )

    assert captured["body"] == {
        "action": "Ship the order under the current tariff",
        "context": "HTS 8471.30",
        "mode": "standard",
        "max_wait_ms": 5000,
        "origin_urls": ["https://hts.usitc.gov/"],
        "materiality": "critical",
        "as_of": "2026-07-26T00:00:00+00:00",
    }


def test_check_accepts_the_canonical_request_mapping():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=CHECK_RESULT)

    with make_client(handler) as c:
        out = c.check({"action": "Approve the claim", "materiality": "high"})

    assert captured["body"] == {"action": "Approve the claim", "materiality": "high"}
    assert out == CHECK_RESULT


def test_check_rejects_mixing_mapping_and_keyword_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="not both"):
            c.check({"action": "x"}, materiality="high")


def test_check_rejects_unknown_request_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="unknown check request fields: belief"):
            c.check({"belief": "x"})


def test_check_rejects_the_old_positional_belief_string_before_network():
    # Pre-0.6 callers wrote check("<belief>"); the error says where that text goes now.
    with refusing_client() as c:
        with pytest.raises(ValueError, match=r"check\(action=\.\.\.\)"):
            c.check("Jane Doe is at Acme")


def test_check_requires_an_action_or_claims_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="at least one of action or claims"):
            c.check(context="no action")
        with pytest.raises(ValueError, match="at least one of action or claims"):
            c.check({"context": "no action"})


def test_check_pre_cancel_skips_transport():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=CHECK_RESULT)

    token = KavalCancellationToken()
    token.cancel("cancelled before check")
    with make_client(handler) as client:
        with pytest.raises(KavalCancelledError):
            client.check(action="x", cancellation_token=token)

    assert calls == 0


# ---------------------------------------------------------------------------
# receipts
# ---------------------------------------------------------------------------


def test_get_receipt_gets_the_signed_receipt_and_unwraps_it():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        return httpx.Response(
            200,
            json={
                "receipt": {
                    "id": "rcpt_1",
                    "decision": "BLOCK",
                    "signature": {"algorithm": "Ed25519", "key_id": "k1"},
                }
            },
        )

    with make_client(handler) as c:
        receipt = c.get_receipt("rcpt_1")

    assert (captured["method"], captured["path"]) == ("GET", "/v1/receipts/rcpt_1")
    assert receipt["id"] == "rcpt_1"
    assert receipt["signature"]["algorithm"] == "Ed25519"


def test_get_receipt_url_encodes_the_id_and_refuses_an_empty_one():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["raw_path"] = request.url.raw_path.decode()
        return httpx.Response(200, json={"receipt": {"id": "a/b"}})

    with make_client(handler) as c:
        c.get_receipt("a/b")
        with pytest.raises(ValueError, match="receipt_id is required"):
            c.get_receipt("   ")

    assert captured["raw_path"] == "/v1/receipts/a%2Fb"


# ---------------------------------------------------------------------------
# sources
# ---------------------------------------------------------------------------


def test_add_source_registers_an_entity_by_name_and_returns_what_it_resolved_to():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/sources"
        assert request.headers.get("idempotency-key") is None
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201, json={"source": SOURCE, "created": True, "resolved": [SOURCE]}
        )

    with make_client(handler) as c:
        out = c.add_source("entity", name="Aetna", intent="payer policy bulletins")

    assert captured["body"] == {
        "kind": "entity",
        "name": "Aetna",
        "intent": "payer policy bulletins",
    }
    assert out["created"] is True
    assert len(out["resolved"]) == 1


def test_add_source_sends_a_url_locator_with_scope_and_poll_interval():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"source": SOURCE, "created": False, "resolved": []})

    with make_client(handler) as c:
        c.add_source(
            "url",
            locator="https://hts.usitc.gov/",
            label="HTS",
            scope_keys=["hts:8471.30"],
            poll_interval_s=900,
        )

    assert captured["body"] == {
        "kind": "url",
        "locator": "https://hts.usitc.gov/",
        "label": "HTS",
        "scope_keys": ["hts:8471.30"],
        "poll_interval_s": 900,
    }


def test_add_source_requires_a_locator_or_a_name_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="locator"):
            c.add_source("url")


def test_list_sources_gets_the_registry_and_opts_into_inactive_rows():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        return httpx.Response(200, json={"sources": [SOURCE]})

    with make_client(handler) as c:
        assert c.list_sources() == [SOURCE]
        c.list_sources(include_inactive=True)

    assert seen == [
        ("GET", "http://test/v1/sources"),
        ("GET", "http://test/v1/sources?include_inactive=true"),
    ]


def test_recompile_source_queues_plan_discovery_and_returns_the_job():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content.decode()))
        return httpx.Response(
            202, json={"source_id": "src_1", "job_id": "job_7", "created": True}
        )

    with make_client(handler) as c:
        out = c.recompile_source("src_1")
        with pytest.raises(ValueError, match="source_id is required"):
            c.recompile_source("  ")

    assert seen == [("POST", "/v1/sources/src_1/recompile", "{}")]
    assert out == {"source_id": "src_1", "job_id": "job_7", "created": True}


def test_source_lifecycle_methods_use_the_exact_routes_and_verbs():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content.decode()))
        return httpx.Response(200, json={"source": SOURCE, "deleted": True, "id": "src_1"})

    with make_client(handler) as c:
        assert c.get_source("src_1") == SOURCE
        assert c.pause_source("src_1") == SOURCE
        assert c.resume_source("src_1") == SOURCE
        assert c.delete_source("src_1")["deleted"] is True

    assert [(method, path) for method, path, _ in seen] == [
        ("GET", "/v1/sources/src_1"),
        ("POST", "/v1/sources/src_1/pause"),
        ("POST", "/v1/sources/src_1/resume"),
        ("DELETE", "/v1/sources/src_1"),
    ]
    # Reads carry no body; the pause/resume POSTs carry an empty JSON object.
    assert [body for _, _, body in seen] == ["", "{}", "{}", ""]


# ---------------------------------------------------------------------------
# events
# ---------------------------------------------------------------------------


def test_send_event_pushes_a_document_and_reports_whether_it_changed():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/events"
        assert request.headers.get("idempotency-key") is None
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "accepted": True,
                "changed": True,
                "source_id": "src_2",
                "version_id": "ver_9",
                "content_sha256": "a" * 64,
                "previous_content_sha256": None,
                "facts_pending_review": 3,
            },
        )

    with make_client(handler) as c:
        out = c.send_event(
            namespace="matey",
            document_id="msa-2026-07",
            content="the amended agreement text",
            scope_keys=["contract:msa-2026-07"],
        )

    assert captured["body"] == {
        "namespace": "matey",
        "document_id": "msa-2026-07",
        "content": "the amended agreement text",
        "scope_keys": ["contract:msa-2026-07"],
    }
    assert out["changed"] is True
    assert out["facts_pending_review"] == 3


# ---------------------------------------------------------------------------
# webhooks
# ---------------------------------------------------------------------------


WEBHOOK_RESULT = {
    "subscription": {"subscription_id": "sub_1"},
    "webhook_verification": {
        "algorithm": "hmac-sha256",
        "key_id": "k1",
        "secret": "s",
        "signed_content": "id.timestamp.body",
        "headers": ["webhook-signature"],
    },
}


def test_subscribe_fact_state_deltas_registers_the_family_with_an_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json=WEBHOOK_RESULT)

    with make_client(handler) as c:
        out = c.subscribe_fact_state_deltas(
            "https://example.com/hooks/kaval",
            external_scope_ids=["contract:msa-2026-07"],
            idempotency_key="webhook-operation-0001",
        )

    assert (captured["method"], captured["path"]) == ("POST", "/v1/webhooks")
    # POST /v1/webhooks refuses a request without a bounded Idempotency-Key header.
    assert captured["key"] == "webhook-operation-0001"
    assert captured["body"] == {
        "subscription_kind": "fact_state",
        "callback_url": "https://example.com/hooks/kaval",
        "event_types": ["fact_state.delta"],
        "external_scope_ids": ["contract:msa-2026-07"],
    }
    assert out["subscription"]["subscription_id"] == "sub_1"
    assert out["webhook_verification"]["secret"] == "s"


def test_create_webhook_generates_an_idempotency_key_when_the_caller_supplies_none():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["key"] = request.headers.get("idempotency-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=WEBHOOK_RESULT)

    with make_client(handler) as c:
        c.create_webhook(
            subscription_kind="fact_state",
            callback_url="https://example.com/hooks/kaval",
            event_types=[FACT_STATE_DELTA_EVENT_TYPE],
            description="deltas",
            enabled=False,
        )

    assert str(uuid.UUID(captured["key"])) == captured["key"]
    # enabled=False is a real value, not an omitted optional.
    assert captured["body"]["enabled"] is False
    assert captured["body"]["description"] == "deltas"


def test_create_webhook_rejects_a_non_https_callback_url_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="https"):
            c.create_webhook(
                subscription_kind="fact_state",
                callback_url="http://example.com/hooks",
                event_types=[FACT_STATE_DELTA_EVENT_TYPE],
            )
        with pytest.raises(ValueError, match="https"):
            c.subscribe_fact_state_deltas("http://example.com/hooks")


def test_webhook_lifecycle_methods_use_the_exact_routes_and_verbs():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content.decode()))
        return httpx.Response(
            200, json={"subscriptions": [], "subscription_id": "sub_1"}
        )

    with make_client(handler) as c:
        assert c.list_webhooks() == []
        c.set_webhook_enabled("sub_1", False)
        c.delete_webhook("sub_1")
        c.replay_webhook_delivery("del_1")

    assert seen == [
        ("GET", "/v1/webhooks", ""),
        ("PATCH", "/v1/webhooks/sub_1", '{"enabled":false}'),
        ("DELETE", "/v1/webhooks/sub_1", ""),
        ("POST", "/v1/webhook-deliveries/del_1/replay", "{}"),
    ]


# ---------------------------------------------------------------------------
# outcomes
# ---------------------------------------------------------------------------


def test_report_outcome_posts_without_an_idempotency_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/report-outcome"
        assert request.headers.get("idempotency-key") is None
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    with make_client(handler) as c:
        assert c.report_outcome("rcpt_1", "relied_and_correct")["ok"] is True

    assert captured["body"] == {"id": "rcpt_1", "kind": "relied_and_correct"}


# ---------------------------------------------------------------------------
# verify() — the deprecated pilot alias, kept exactly as it was
# ---------------------------------------------------------------------------


def test_verify_posts_conclusion_and_evidence_refs_and_returns_receipt():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        assert request.headers["content-type"] == "application/json"
        captured["idempotency_key"] = request.headers["idempotency-key"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(
            conclusion="The 2024 International Building Code is the current IBC edition.",
            evidence_refs=["https://codes.iccsafe.org/content/IBC2024V2.0"],
        )

    assert captured["body"] == {
        "conclusion": "The 2024 International Building Code is the current IBC edition.",
        "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
    }
    # The one billable op: a fresh UUID idempotency key rides the wire automatically.
    assert str(uuid.UUID(captured["idempotency_key"])) == captured["idempotency_key"]
    assert out["status"] == "valid"
    receipt = out["receipt"]
    assert receipt["decision"] == "ALLOW"
    assert receipt["share_endpoint"] == f"/v1/proofs/{receipt['proof_id']}/share"
    # No receipt-level expiry: it lives on the packet's action decision.
    assert "expires_at" not in receipt
    assert receipt["packet"]["action_decision"]["expires_at"]
    assert receipt["packet"]["signature"]["algorithm"] == "Ed25519"
    assert receipt["packet"]["signature"]["key_id"] == "proof-ed25519-2026-07"


def test_verify_accepts_the_canonical_request_mapping():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(
            {
                "conclusion": "The 2024 International Building Code is the current IBC edition.",
                "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
                "materiality": "high",
            }
        )

    assert captured["body"] == {
        "conclusion": "The 2024 International Building Code is the current IBC edition.",
        "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
        "materiality": "high",
    }
    assert out == VERIFY_RESULT


def test_verify_serializes_optional_fields_and_document_bound_refs_exactly():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        c.verify(
            conclusion="Supplier X holds an active ISO 9001 certificate.",
            evidence_refs=[
                "https://registry.example/cert/123",
                {"url": "https://supplier.example/quality", "document_id": "doc-1"},
            ],
            as_of="2026-07-20T10:00:00+00:00",
            materiality="critical",
            intended_action="Approve the supplier onboarding",
            reversibility="irreversible",
            jurisdiction="US",
            context="procurement gate",
        )

    assert captured["body"] == {
        "conclusion": "Supplier X holds an active ISO 9001 certificate.",
        "evidence_refs": [
            "https://registry.example/cert/123",
            {"url": "https://supplier.example/quality", "document_id": "doc-1"},
        ],
        "as_of": "2026-07-20T10:00:00+00:00",
        "materiality": "critical",
        "intended_action": "Approve the supplier onboarding",
        "reversibility": "irreversible",
        "jurisdiction": "US",
        "context": "procurement gate",
    }


def test_verify_rejects_mixing_mapping_and_keyword_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="not both"):
            c.verify(
                {"conclusion": "x", "evidence_refs": ["https://a.example/"]},
                materiality="high",
            )


def test_verify_rejects_unknown_request_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="unknown verify request fields: belief"):
            c.verify({"belief": "x", "evidence_refs": ["https://a.example/"]})


def test_verify_rejects_the_old_positional_conclusion_string_before_network():
    # verify("a sentence") used to reach request.keys() and die with an AttributeError about str.
    with refusing_client() as c:
        with pytest.raises(ValueError, match=r"verify\(conclusion=\.\.\."):
            c.verify("The 2024 IBC is the current edition")


def test_verify_requires_a_conclusion_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="conclusion"):
            c.verify(evidence_refs=["https://a.example/"])


@pytest.mark.parametrize(
    ("evidence_refs", "message"),
    [
        (None, "1 to 20"),
        ([], "between 1 and 20"),
        ([f"https://a.example/{i}" for i in range(21)], "between 1 and 20"),
        # A bare object WITHOUT document_id is invalid — must be a plain string instead.
        ([{"url": "https://a.example/"}], "pass a plain URL string"),
        ([{"url": "https://a.example/", "document_id": ""}], "exactly"),
        (
            [{"url": "https://a.example/", "document_id": "d", "extra": 1}],
            "exactly",
        ),
        ([7], "URL string"),
        (
            [
                {"url": "https://a.example/", "document_id": "same"},
                {"url": "https://b.example/", "document_id": "same"},
            ],
            "unique",
        ),
    ],
)
def test_verify_rejects_invalid_evidence_refs_before_network(evidence_refs, message):
    with refusing_client() as c:
        with pytest.raises(ValueError, match=message):
            c.verify(conclusion="an assertable proposition", evidence_refs=evidence_refs)


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "current", "receipt": VERIFY_RESULT["receipt"]},
        {"status": "valid"},
        {"status": "valid", "receipt": {}},
        {
            "status": "valid",
            "receipt": {**VERIFY_RESULT["receipt"], "decision": "SAFE"},
        },
        {
            "status": "valid",
            "receipt": {
                key: value
                for key, value in VERIFY_RESULT["receipt"].items()
                if key != "packet"
            },
        },
    ],
)
def test_verify_rejects_a_malformed_verdict_envelope(payload):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="conclusion-verification envelope"):
            c.verify(conclusion="x is y", evidence_refs=["https://a.example/"])


def test_verify_pre_cancel_skips_transport_and_retains_operation_key():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=VERIFY_RESULT)

    token = KavalCancellationToken()
    token.cancel("cancelled before verify")
    with make_client(handler) as client:
        with pytest.raises(KavalCancelledError) as raised:
            client.verify(
                conclusion="x is y",
                evidence_refs=["https://a.example/"],
                idempotency_key="verify-pre-cancel-0001",
                cancellation_token=token,
            )

    assert calls == 0
    assert raised.value.idempotency_key == "verify-pre-cancel-0001"


def test_verify_transport_ambiguity_retries_once_with_same_generated_key():
    keys = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            raise httpx.ConnectError(
                "connection reset after request write", request=request
            )
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(conclusion="x is y", evidence_refs=["https://a.example/"])

    assert out["status"] == "valid"
    assert len(keys) == 2
    assert keys[1] == keys[0]


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (409, "idempotency_in_progress"),
        (503, "idempotency_resolution_pending"),
        (503, "event_persistence_pending"),
    ],
)
def test_verify_ambiguous_response_retries_once_with_same_caller_key(status, code):
    keys = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            return httpx.Response(status, json={"error": {"code": code}})
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(
            conclusion="x is y",
            evidence_refs=["https://a.example/"],
            idempotency_key="caller-operation-0001",
        )

    assert out["status"] == "valid"
    assert keys == ["caller-operation-0001", "caller-operation-0001"]


def test_verify_ambiguous_retries_are_bounded():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(409, json={"error": {"code": "idempotency_in_progress"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.verify(conclusion="x is y", evidence_refs=["https://a.example/"])

    assert exc.value.status_code == 409
    assert uuid.UUID(exc.value.idempotency_key)
    assert calls == ["/v1/verify", "/v1/verify"]


def test_verify_malformed_success_response_raises_json_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, text="not-json")

    with make_client(handler) as c:
        with pytest.raises(ValueError) as exc:
            c.verify(conclusion="x is y", evidence_refs=["https://a.example/"])

    assert uuid.UUID(exc.value.idempotency_key)
    assert calls == ["/v1/verify"]


# ---------------------------------------------------------------------------
# Shared transport behavior
# ---------------------------------------------------------------------------


def test_auth_header_is_set():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer secret"
        return httpx.Response(200, json=CHECK_RESULT)

    client = KavalClient(
        base_url="http://test", api_key="secret", transport=httpx.MockTransport(handler)
    )
    client.check(action="x")
    client.close()


def test_error_response_raises():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": {"code": "subscription_required"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.check(action="x")
    assert exc.value.status_code == 402
    assert not isinstance(exc.value, KavalRetiredError)


@pytest.mark.parametrize("method", ["GET", "POST", "DELETE", "PATCH"])
def test_retired_route_raises_kaval_retired_error_on_the_plain_path(method):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(410, json=RETIRED_BODY)

    calls = {
        "GET": lambda c: c.list_sources(),
        "POST": lambda c: c.check(action="x"),
        "DELETE": lambda c: c.delete_source("src_1"),
        "PATCH": lambda c: c.set_webhook_enabled("sub_1", False),
    }
    with make_client(handler) as c:
        with pytest.raises(KavalRetiredError) as exc:
            calls[method](c)

    assert isinstance(exc.value, KavalError)
    assert exc.value.status_code == 410
    assert exc.value.code == "tool_retired"
    assert exc.value.replacement == "/v1/check"
    assert "check()" in str(exc.value)
    assert "retired in v0.6" in str(exc.value)


def test_retired_route_raises_kaval_retired_error_on_the_billable_path():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(410, json={"error": "tool_retired"})

    with make_client(handler) as c:
        with pytest.raises(KavalRetiredError) as exc:
            c.verify(
                conclusion="x is y",
                evidence_refs=["https://a.example/"],
                idempotency_key="retired-0001",
            )

    # No replacement in the body: the client still points the caller at /v1/check.
    assert exc.value.replacement == "/v1/check"
    assert exc.value.idempotency_key == "retired-0001"
    assert "/v1/verify" in str(exc.value)
    # A retired route is terminal — never retried under the ambiguous-idempotency rule.
    assert calls == ["/v1/verify"]


def test_a_plain_410_is_not_a_retired_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(410, json={"error": {"code": "gone"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.check(action="x")

    assert not isinstance(exc.value, KavalRetiredError)
    assert exc.value.status_code == 410


def test_default_base_url_is_the_cloud():
    assert DEFAULT_BASE_URL == "https://api.usekaval.com"

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json=CHECK_RESULT)

    # No base_url given → defaults to the hosted cloud.
    client = KavalClient(transport=httpx.MockTransport(handler))
    client.check(action="x")
    client.close()
    assert captured["url"] == "https://api.usekaval.com/v1/check"


def test_health_success_returns_dict():
    payload = {"ok": True, "name": "kaval", "version": "0.6.0"}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/health"
        return httpx.Response(200, json=payload)

    with make_client(handler) as c:
        out = c.health()

    assert out == payload


def test_health_raises_on_non_2xx():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.health()
    assert exc.value.status_code == 503


def test_health_propagates_timeout_exception():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    with make_client(handler) as c:
        with pytest.raises(httpx.TimeoutException):
            c.health()


def test_health_takes_a_deadline_and_a_cancellation_token_like_every_other_call():
    # health() used to hit the transport directly — the one call most likely to be pointed at an
    # unreachable host was the only one that could be neither bounded nor cancelled.
    captured = {}
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json={"ok": True})

    with make_client(handler) as c:
        assert c.health(timeout=3.0)["ok"] is True
        token = KavalCancellationToken()
        token.cancel("no longer needed")
        with pytest.raises(KavalCancelledError):
            c.health(cancellation_token=token)

    assert captured["timeout"]["read"] == 3.0
    # The pre-cancelled probe never reached the transport.
    assert calls == 1


def test_check_propagates_connect_error_without_retrying():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        raise httpx.ConnectError("connection refused", request=request)

    # A check is not billable: no idempotency key, and therefore no safety replay.
    with make_client(handler) as c:
        with pytest.raises(httpx.ConnectError):
            c.check(action="x")
    assert calls == ["/v1/check"]


def test_no_automatic_retries_on_http_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    with KavalClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(KavalError) as exc:
            c.check(action="x")
        assert exc.value.status_code == 503

    assert calls == ["/v1/check"]


def test_default_timeout_outlives_the_servers_own_deadline():
    # The server's handler deadline is 150s and a cold check may spend 100s researching. A 30s
    # client deadline aborted the quickstart's first call on the server's normal behavior.
    assert DEFAULT_TIMEOUT_SECONDS == 150.0
    with KavalClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=CHECK_RESULT))
    ) as c:
        assert c._http.timeout.read == 150.0


def test_timeout_is_overridable_per_client_and_per_call():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json=CHECK_RESULT)

    with KavalClient(timeout=5.0, transport=httpx.MockTransport(handler)) as c:
        assert c._http.timeout.read == 5.0
        c.check(action="x", timeout=12.0)

    assert captured["timeout"]["read"] == 12.0


def test_no_timeout_disables_the_deadline_where_none_only_inherits_it():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions.get("timeout"))
        return httpx.Response(200, json=CHECK_RESULT)

    with KavalClient(timeout=5.0, transport=httpx.MockTransport(handler)) as c:
        c.check(action="x")                    # None → the client's 5s
        c.check(action="x", timeout=NO_TIMEOUT)  # the sentinel → no deadline at all

    assert seen[0]["read"] == 5.0
    assert seen[1]["read"] is None


def test_no_timeout_disables_the_client_wide_deadline_too():
    with KavalClient(
        timeout=NO_TIMEOUT,
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=CHECK_RESULT)),
    ) as c:
        assert c._http.timeout.read is None


def test_env_defaults_api_key_and_base_url(monkeypatch):
    monkeypatch.setenv("KAVAL_API_KEY", "kv_live_from_env")
    monkeypatch.setenv("KAVAL_BASE_URL", "http://env.test")

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["host"] = str(request.url)
        return httpx.Response(200, json=CHECK_RESULT)

    with KavalClient(transport=httpx.MockTransport(handler)) as c:
        c.check(action="Jane Doe is at Acme")

    assert captured["auth"] == "Bearer kv_live_from_env"
    assert captured["host"].startswith("http://env.test/v1/check")


def test_explicit_args_override_env(monkeypatch):
    monkeypatch.setenv("KAVAL_API_KEY", "kv_live_from_env")
    monkeypatch.setenv("KAVAL_BASE_URL", "http://env.test")

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["host"] = str(request.url)
        return httpx.Response(200, json=CHECK_RESULT)

    with KavalClient(
        base_url="http://explicit.test",
        api_key="kv_live_explicit",
        transport=httpx.MockTransport(handler),
    ) as c:
        c.check(action="x")

    assert captured["auth"] == "Bearer kv_live_explicit"
    assert captured["host"].startswith("http://explicit.test/v1/check")
