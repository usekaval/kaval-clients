# kaval (Python SDK)

The primary loop: **watch a source → extract structured records against a schema → get pushed a
`policy_update.*` webhook as documents land.** Register what Kaval should watch with
`add_source()`, bind an `ExtractionSchema` to it, and subscribe once — no polling.

```
add_source()  →  create_extraction_schema() + update_source()  →  subscribe_policy_updates()
   (watch)               (what to extract)                            (get pushed the result)
```

Before an AI agent acts, it can also send Kaval the action directly: **`check()`** identifies the
facts that action depends on, checks them against the sources Kaval watches, and returns `ALLOW`,
`REVIEW`, or `BLOCK` with a signed receipt. Everything else configures what Kaval watches, so that a
check stays a warm database read instead of a research run: push your own documents with
`send_event()`, and subscribe to `fact_state.delta` webhooks with `subscribe_fact_state_deltas()`
so you are _told_ when a fact flips instead of polling for it.

Version 0.7.3 does not expose contracts, fact imports, structured bulletins, or training review.

Use the Node SDK or MCP server for those portfolio operations.

Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.

## Install

```bash
pip install kaval
```

## Quickstart

```python
from kaval import KavalClient

with KavalClient(api_key="kv_live_...") as kaval:
    result = kaval.check(
        action="Approve the prior-auth claim for CPT 12345 at the current rate",
        context="payer: Aetna",
    )

    if result["decision"] != "ALLOW":       # REVIEW is never permission to act
        hold_for_human(result)
    else:
        approve_claim()

    save_receipt(result["receipt"]["id"])   # the proof that this was checked
```

`check()` takes either one mapping (`kaval.check({"action": ...})`) or the same fields as keywords
— never both:

| field         | meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `action`      | what the agent is about to do, in plain language. Kaval compiles the facts.      |
| `context`     | anything the agent already knows that bears on the action.                       |
| `claims`      | facts to check directly — plain sentences or structured claims (max 20).         |
| `mode`        | `fast` (stored fact state only) or `standard` (allows the live fallback).        |
| `max_wait_ms` | live-path budget (default 100000, max 100000; `0` disables research). See below. |
| `origin_urls` | caller-declared origins, merged with the workspace's watched sources.            |
| `materiality` | `low` \| `medium` \| `high` \| `critical`.                                       |
| `as_of`       | RFC 3339 timestamp to check against.                                             |

At least one of `action` or `claims` is required — the client raises `ValueError` before any HTTP
call otherwise. A check is a **read**: it sends no `Idempotency-Key`, and retrying it is free.

`max_wait_ms` bounds only the **live research** path. Its ceiling equals its default on purpose:
the budget is there for a caller who would rather have a bounded `REVIEW` than wait, never to ask
for more time. A cold action check with several novel facts routinely needs 50–100 s of search,
fetch and adjudication, so cutting the budget short returns `unknown` facts rather than a faster
verdict. `0` disables research entirely — which is exactly what `mode="fast"` sets.

The response:

- `decision` — **ALLOW** (every material fact still holds on a fresh basis), **REVIEW** (something
  is unknown, changed at low/medium materiality, or mid-re-evaluation), or **BLOCK** (a
  high/critical fact changed, or a critical fact is unknown). **Only ALLOW means "safe to act".**
- `reason_codes` — why, from a closed eight-code taxonomy (`ALL_FACTS_HOLD`, `FACT_CHANGED`,
  `FACT_EXPIRED`, `FACT_UNKNOWN`, `SOURCE_UPDATED_PENDING_REVIEW`, `SOURCE_UNREACHABLE`,
  `NEW_FACT_UNVERIFIED`, `COMPILATION_UNCERTAIN`).
- `facts` — one row per fact: `fingerprint`, `text`, `status` (`holds` | `changed` | `unknown`),
  `materiality`, `served_from_state`, `last_verified_at`, `sources`.
- `receipt` — `{id, signature, signed_at}`. `get_receipt(id)` returns the full signed document,
  which re-derives the verdict offline (the decision table is published).
- `latency_ms` — `compile`, `lookup`, `live`, `total`.

Structured claims are the zero-LLM path — they canonicalize straight to a fact fingerprint, so the
warm lookup needs no model call:

```python
result = kaval.check(
    claims=[
        {"subject": "Aetna", "predicate": "requires_prior_auth_for", "object": "CPT 12345"},
        "The 2024 International Building Code is the current IBC edition",
    ],
    mode="fast",
)
```

## Tell Kaval what to watch

```python
# A URL, polled conditionally.
kaval.add_source("url", locator="https://hts.usitc.gov/", scope_keys=["hts:8471.30"])

# An entity by name — Kaval resolves it to the URLs that publish it and watches those.
kaval.add_source("entity", name="Aetna", intent="payer policy bulletins")

# A document you own: push it and Kaval versions, diffs, and re-evaluates the dependent facts.
kaval.send_event(
    namespace="matey",
    document_id="msa-2026-07",
    content=amended_agreement_text,
    scope_keys=["contract:msa-2026-07"],
)
```

`list_sources(include_inactive=False)`, `get_source(id)`, `pause_source(id)`, `resume_source(id)`,
and `delete_source(id)` manage the registry. Facts learned from a watched source stay warm, so
checks on them are a database read.

`recompile_source(id)` re-derives how a source is acquired. A directly-registered URL starts out
polled with a plain conditional GET; this is what asks discovery to work out what actually
publishes it, and the only recovery once a working plan breaks against a redesigned site. It
answers `202 {source_id, job_id, created}` — the job is queued, not finished, and `created` is
`False` when an open job for that source absorbed the request.

## Policy updates

Register a JSON Schema and bind it to a source; every document that lands on that source afterward
is extracted against it and delivered as a `policy_update.document` webhook, with per-payer monthly
rollups delivered as `policy_update.monthly_package`. On each document event, `extraction_run.period`
is the publication / newsletter month (`YYYY-MM`); sections and `extraction.record_evidence` may
include normalized `page` / `bbox` for PDF highlighting; `result["payer_name"]` is the human brand
beside the stable `payer_id` slug.

```python
schema = kaval.create_extraction_schema(
    name="prior-auth-changes",
    json_schema={
        "type": "object",
        "properties": {
            "cpt_code": {"type": "string"},
            "requires_prior_auth": {"type": "boolean"},
        },
        "required": ["cpt_code", "requires_prior_auth"],
    },
)

kaval.update_source(source["id"], extraction_schema_id=schema["id"])
# extraction_schema_id=None unbinds it, leaving the source watched but unextracted.
```

Prefer a one-off run over waiting for the next document? `create_policy_update()` requests a payer
+ period extraction run directly against a bound schema:

```python
run = kaval.create_policy_update(
    payer_id="aetna", period="2026-08", extraction_schema_id=schema["id"]
)
# 202, run["status"] == "processing" — poll get_policy_update(run["id"]) or wait for the webhook.

kaval.list_policy_updates(payer_id="aetna", period="2026-08")
kaval.get_policy_update(run["id"])
kaval.list_extraction_schemas()
kaval.get_extraction_schema(schema["id"])
```

Each payer + period's runs roll up into one monthly PDF + manifest:

```python
kaval.list_policy_update_packages(payer_id="aetna", period="2026-08")
pkg = kaval.get_policy_update_package(pkg_id)
# pkg["pdf_href"] → GET /v1/policy-update-packages/{id}/document → 302 signed PDF (follow redirects).
```

Read the canonical text (or heading-bounded sections) a source version was extracted from,
independent of any bound schema:

```python
content = kaval.get_source_version_content(source_version_id)["content"]
sections = kaval.get_source_version_content(source_version_id, format="sections")["sections"]
```

Subscribe once, the same way as `fact_state.delta`:

```python
subscription = kaval.subscribe_policy_updates(
    "https://your-app.com/hooks/kaval",
    external_scope_ids=["payer:aetna"],   # optional scope filter
)
secret = subscription["webhook_verification"]["secret"]   # shown once — store it now
```

`create_extraction_schema()` and `create_policy_update()` require an API key with
`policy-update:manage`; the read methods above accept `policy-update:read` or
`verification:execute`.

## Get told when a fact flips

```python
subscription = kaval.subscribe_fact_state_deltas(
    "https://your-app.com/hooks/kaval",
    external_scope_ids=["contract:msa-2026-07"],   # omit to receive everything
)
secret = subscription["webhook_verification"]["secret"]   # shown once — store it now
```

Without a subscription the background loops still keep fact state fresh, but nothing tells you a
fact flipped until your next `check()`. Each delivery is a `fact_state.delta` event (typed as
`FactStateDeltaEvent`) naming the source, the old/new content hashes, and every fact whose state
changed with its basis.

### Verifying a delivery

Your callback URL is a public HTTPS endpoint, and a delta is an instruction worth forging — "a fact
your agent relies on just flipped". `verify_webhook_signature` is the receiving half of Kaval's
signature: HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw body>`, compared in constant time.
It imports nothing but the standard library and never contacts Kaval.

```python
import json
import os

from fastapi import FastAPI, Request, Response
from kaval import FactStateDeltaEvent, verify_webhook_signature

# webhook-key-id → that generation's secret. During a rotation overlap BOTH generations sign real
# deliveries, so hold both here and the rollover is a config change instead of an outage.
SECRETS = {os.environ["KAVAL_WEBHOOK_KEY_ID"]: os.environ["KAVAL_WEBHOOK_SECRET"]}

app = FastAPI()


@app.post("/hooks/kaval")
async def kaval_delta(request: Request) -> Response:
    # await request.body(), NOT the parsed model: the signature covers the exact bytes on the wire.
    # A body that has been parsed and re-serialised has a different MAC, and no genuine delivery
    # would ever verify.
    raw = await request.body()
    result = verify_webhook_signature(
        body=raw,
        headers=request.headers,
        secrets=SECRETS,
        tolerance_seconds=300,  # default; the replay window either side of now
    )
    if not result:
        # 400, not 401 — a retry will not make an unsigned request signed. `result.reason` is one of
        # missing_header · malformed_timestamp · unknown_key_id · unsupported_signature_version ·
        # malformed_signature · signature_mismatch · timestamp_out_of_tolerance, safe to log.
        return Response(status_code=400, content=result.reason)

    # Delivery is at-least-once by design: a retry after your 500 is a legitimate duplicate. Dedupe
    # on result.webhook_id (the event's own id) before doing anything with side effects.
    if already_processed(result.webhook_id):
        return Response(status_code=200)

    event: FactStateDeltaEvent = json.loads(raw)
    data = event["data"]
    for fact in data["facts"]:
        # "Aetna requires prior auth for CPT 12345" — holds → changed, at critical materiality.
        print(
            fact["materiality"],
            f"{fact['old_state']} → {fact['new_state']}: {fact['text']}",
            f"via {data['source']['locator']}",
            f"({data['old_version_sha256']} → {data['new_version_sha256']})",
            [ref["source_locator"] for ref in fact["basis"]],
        )
    # data["diff_summary"] carries changed_sections + stats, if you want to show what moved.

    # Answer 2xx quickly; Kaval retries non-2xx with backoff, then dead-letters the delivery.
    return Response(status_code=202)
```

`WebhookSignatureResult` is truthy exactly when it is valid, so `if not result:` is both the obvious
spelling and the correct one. On success it also carries `key_id`, `webhook_id`, and the signer's
`timestamp` as an aware `datetime`. It raises `TypeError` only for your own mistakes — an empty
`secrets` mapping, a parsed body — never for anything an attacker controls.

`POST /v1/webhooks` requires an `Idempotency-Key`; the client always sends one (a fresh UUID when
you supply no `idempotency_key=`). Manage subscriptions with `list_webhooks()`,
`set_webhook_enabled(id, enabled)`, `delete_webhook(id)`, and `replay_webhook_delivery(id)` for a
dead-lettered delivery after you fix the receiving endpoint.

## Report what actually happened

```python
kaval.report_outcome(result["receipt"]["id"], "relied_and_correct")
```

`kind` is one of `current_later_contradicted`, `stale_caught_real`, `stale_was_false_alarm`, or
`relied_and_correct`. Outcomes calibrate the decision.

## Migrating from 0.5

Every pre-0.6 verification endpoint collapsed into `POST /v1/check`. The old routes answer
`410 {"error": "tool_retired"}` on every method, which this client raises as `KavalRetiredError`
(a `KavalError` with `.replacement`, and a message that names `check()`).

| old                                    | new                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `audit()` / `gate()` / `gate_action()` | `check()` — the receipt IS the proof; the warm path re-checks from stored state |
| `check(belief=...)` (old belief shape) | `check(action=...)` or `check(claims=[...])`                                    |
| `legacy_verify_belief()`               | `check(action=..., context=...)`                                                |
| `extract_and_check(text=...)`          | `check(action=<the text>)` — Kaval compiles the facts itself                    |
| `scan_store(beliefs=[...])`            | `check(claims=[...])` (up to 20 per call)                                       |
| `monitor(...)`                         | `add_source()` + `subscribe_fact_state_deltas()` — deltas are pushed to you     |
| `kaval()` / `kaval_batch()`            | `check(claims=[...])` with structured claims                                    |
| `verify()`                             | still `verify()`, deprecated → move to `check()`                                |

`KavalProofNotFoundError` is gone with `/v1/gate`.

## `verify()` — deprecated pilot alias

`verify()` checks one load-bearing conclusion against explicit evidence references and returns a
`ProofPacket` receipt. It is kept only while the existing pilots migrate; new integrations should
use `check()`.

```python
result = kaval.verify(
    conclusion="The 2024 International Building Code is the current IBC edition.",
    evidence_refs=["https://codes.iccsafe.org/content/IBC2024V2.0"],
)
result["status"]              # "valid" | "invalidated" | "could_not_verify"
result["receipt"]["decision"] # "ALLOW" | "BLOCK" | "REVIEW"
```

`evidence_refs` holds 1–20 references; each is a plain https URL string, or a strict
`{"url": ..., "document_id": ...}` object when the document has a stable identity (a bare object
without `document_id` is invalid; `document_id` values must be unique). Expiry lives at
`result["receipt"]["packet"]["action_decision"]["expires_at"]`. Receipts are Ed25519-signed and
verifiable offline against `GET /v1/proof-verification-keys/:kid`.

`verify()` is the only call that **spends an operation key**: it sends an `Idempotency-Key`
automatically and retries once after an ambiguous failure. That is not the same as being the only
metered call — every successful `check()` is metered too; it simply is not replayed, because a
check is a read of current state.

**Honest boundaries.** Demo results carry no organizational authority. A production `ALLOW`
requires a customer-bound action policy and applicable empirical calibration; `REVIEW` is never
permission.

## Pydantic AI guardrail (one line)

Gate a [Pydantic AI](https://ai.pydantic.dev) agent's outputs on the check verdict. Before the
answer leaves the run, Kaval verifies the facts it depends on; anything other than ALLOW raises
`ModelRetry` with the changed/unknown facts and their sources, and the agent re-answers with the
correction in context:

```python
# pip install "kaval[pydantic-ai]"
from pydantic_ai import Agent
from kaval.pydantic_ai import verify_output

agent = Agent("openai:gpt-5")
agent.output_validator(verify_output())  # <- the guardrail
```

By default the whole plain-text output is sent as the `action` and Kaval compiles the facts itself.
For structured outputs, say which claims are checkable:

```python
agent.output_validator(
    verify_output(claims=lambda out: [f"{out.company}'s CEO is {out.ceo}"], mode="fast")
)
```

`verify_output(...)` also takes `client=` (a configured `KavalClient`), `materiality=`,
`max_wait_ms=`, and `context=`. An answer that does not fit in one check — over 10 000 characters,
more than 20 claims, or a single claim over 2 000 characters — raises `ModelRetry` asking for a
shorter one instead of sending a body the API rejects; the surplus is never dropped, because a
dropped claim is an unchecked claim and an unchecked claim reads as ALLOW. Streaming runs are
supported — partial chunks pass through and only the complete output is checked. Each retry consumes the run's output-retry budget
(`Agent(retries={"output": N})`). Full runnable example: `examples/pydantic_ai_guardrail.py`.

## Async / concurrency

**Sync-only for now.** `KavalClient` is built on `httpx.Client` (blocking I/O) and does not yet ship
an `AsyncKavalClient`. If you need `async`/`await`, call the REST API with `httpx.AsyncClient`, wrap
sync calls in `asyncio.to_thread()`, or use the Node SDK (`@usekaval/kaval`). Native async may land
in a later release.

## Caller cancellation

Every method that makes a request — `health()` included — accepts a thread-safe, one-shot
cancellation token, and a `timeout=`:

```python
from threading import Timer
from kaval import KavalCancellationToken, KavalCancelledError, KavalClient

token = KavalCancellationToken()
timer = Timer(2.0, lambda: token.cancel("request no longer needed"))
timer.start()
try:
    with KavalClient(api_key="kv_live_...") as client:
        result = client.check(action="Approve the claim", cancellation_token=token)
except KavalCancelledError as error:
    # Billable calls (verify) retain their recovery key.
    recoverable_operation_key = error.idempotency_key
finally:
    timer.cancel()
```

A token cancelled before call entry performs no HTTP request. In flight, cancellation releases the
blocked caller, never triggers the SDK's bounded retry, and requests best-effort closure of an open
or later-arriving response. The first `cancel(reason)` wins, and its reason is available on
`KavalCancelledError`.

The synchronous httpx public API has no portable hard-abort equivalent to JavaScript `AbortSignal`
for blocking I/O. Kaval uses only the public `Response.close()` cleanup API; depending on the
platform and transport phase, a daemon worker may remain until the underlying I/O returns or its
configured `timeout=` expires. Keep a finite timeout as the transport-level cleanup backstop.

## Custom base URL

```python
client = KavalClient(base_url="https://staging.api.usekaval.com", api_key="...")
```

## Environment variables

When omitted, constructor args fall back to:

| Variable         | Used for     | Default                    |
| ---------------- | ------------ | -------------------------- |
| `KAVAL_API_KEY`  | Bearer token | none (unauthenticated)     |
| `KAVAL_BASE_URL` | API origin   | `https://api.usekaval.com` |

Explicit `api_key=` / `base_url=` always wins over the environment.

## Errors and resilience

- `KavalError` — any non-2xx response (`.status_code`, `.payload`, `.idempotency_key`).
- `KavalRetiredError` — HTTP 410 `tool_retired` from a pre-0.6 route; `.replacement` is
  `/v1/check`.
- `KavalCancelledError` — a `cancellation_token` fired.
- Timeouts surface as `httpx.TimeoutException`, not `KavalError`.

`verify()` is the only method that reserves an idempotency key by default: it sends a fresh UUID
`Idempotency-Key` and performs one safety retry after an ambiguous `httpx.TransportError`, or when
the API says the same operation is still in progress/finalizing; that retry reuses the exact key.
Ordinary API errors, rate limits, and terminal 5xx responses are never retried. Pass
`idempotency_key=` when an outer job system needs one logical operation to stay stable, and reuse a
key only after an ambiguous/no-response failure.
`create_webhook()` (and `subscribe_fact_state_deltas()` / `subscribe_policy_updates()`),
`create_extraction_schema()`, and `create_policy_update()` also send an `Idempotency-Key` because
the server requires one; they are never auto-retried.

**Default timeout: 150 seconds** (connect + read), overridable at construction or per call:

```python
from kaval import NO_TIMEOUT

client = KavalClient(api_key="...", timeout=60.0)
client.check(action="...", timeout=10.0)         # a bounded deadline for this call
client.check(action="...", timeout=NO_TIMEOUT)   # no deadline at all for this call
```

The default sits just above the server's own 150 s handler deadline, which in turn sits above the
100 s a cold check may spend on live research. A shorter client deadline does not make the answer
arrive sooner — it throws away the research that was about to produce it. Pass `max_wait_ms` when
you genuinely want a faster, bounded verdict. `timeout=None` per call means "inherit the client's";
`NO_TIMEOUT` is the value that removes it.

## API

`check` · `get_receipt` · `add_source` · `list_sources` · `get_source` · `pause_source` ·
`resume_source` · `recompile_source` · `delete_source` · `update_source` ·
`get_source_version_content` · `send_event` · `create_extraction_schema` ·
`get_extraction_schema` · `list_extraction_schemas` · `create_policy_update` ·
`get_policy_update` · `list_policy_updates` · `get_policy_update_package` ·
`list_policy_update_packages` · `subscribe_policy_updates` · `subscribe_fact_state_deltas` ·
`create_webhook` · `list_webhooks` · `set_webhook_enabled` · `delete_webhook` ·
`replay_webhook_delivery` · `report_outcome` · `verify` (deprecated) · `health`. Construct with
`KavalClient(base_url=?, api_key=?, timeout=?)` — `base_url` defaults to
`https://api.usekaval.com`. The Node/TypeScript client mirrors this surface:
`npm install @usekaval/kaval`.

`verify_webhook_signature` is a module-level function, not a client method: a receiver needs no API
key, no base URL and no network to decide whether an inbound delivery is genuine.

## Test

```bash
pip install -e ".[dev]"            # from sdks/python (development)
pytest                             # hermetic contract tests (httpx MockTransport)
KAVAL_BASE_URL=https://api.usekaval.com KAVAL_API_KEY=kv_live_... pytest   # also runs the live test
```
