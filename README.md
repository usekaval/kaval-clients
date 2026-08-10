# Kaval clients

Open-source client libraries for [Kaval](https://usekaval.com). **Register the payers and pages you
care about once. Kaval watches them, extracts structured records against a schema you define, and
delivers each policy update — plus a monthly PDF + manifest rollup — as a webhook the moment it
lands, instead of you polling or re-researching it.** `check()` is the second half: before an agent
acts on one of those facts, send Kaval the action and it answers `ALLOW`, `REVIEW`, or `BLOCK` with a
signed receipt.

**Policy engines decide whether an action is permitted under the rules; Kaval verifies whether the
facts those rules depend on are still true.**

These are **thin HTTP clients** for the hosted Kaval API (`https://api.usekaval.com`). Create an API
key at [usekaval.com](https://usekaval.com).

| Package                         | Language          | Install                 | Source                       |
| ------------------------------- | ----------------- | ----------------------- | ---------------------------- |
| [`@usekaval/kaval`](sdks/node)  | Node / TypeScript | `npm i @usekaval/kaval` | [sdks/node](sdks/node)       |
| [`kaval`](sdks/python)          | Python            | `pip install kaval`     | [sdks/python](sdks/python)   |
| [`@usekaval/mcp`](packages/mcp) | MCP server        | `npx -y @usekaval/mcp`  | [packages/mcp](packages/mcp) |

The 0.7.3 portfolio methods are available in the Node SDK and MCP server.

The Python SDK does not yet expose contracts, fact imports, bulletins, or training review.

## Sources → Policy updates → Webhooks

The primary loop needs no LLM call and no polling loop of your own:

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

// 1. Watch a payer.
const { source } = await kaval.addSource({
  kind: "entity",
  name: "Aetna",
  intent: "payer policy bulletins",
});

// 2. Register the shape you want extracted, and bind it to the source.
const schema = await kaval.createExtractionSchema({
  name: "prior-auth-bulletin",
  json_schema: {
    type: "object",
    properties: { cpt_code: { type: "string" }, requires_prior_auth: { type: "boolean" } },
    required: ["cpt_code", "requires_prior_auth"],
  },
});
await kaval.updateSource({ id: source.id, extraction_schema_id: schema.id });

// 3. Get pushed a policy_update.document webhook every time a new bulletin lands, already
//    extracted against the schema — or poll listPolicyUpdates() for the same records.
const { webhook_verification } = await kaval.subscribePolicyUpdates({
  callback_url: "https://your-app.example.com/hooks/kaval",
});
```

```py
import os

from kaval import KavalClient

kaval = KavalClient(api_key=os.environ["KAVAL_API_KEY"])

source = kaval.add_source(kind="entity", name="Aetna", intent="payer policy bulletins")
schema = kaval.create_extraction_schema(
    name="prior-auth-bulletin",
    json_schema={
        "type": "object",
        "properties": {"cpt_code": {"type": "string"}, "requires_prior_auth": {"type": "boolean"}},
        "required": ["cpt_code", "requires_prior_auth"],
    },
)
kaval.update_source(id=source["id"], extraction_schema_id=schema["id"])
kaval.subscribe_policy_updates(callback_url="https://your-app.example.com/hooks/kaval")
```

No schema, or want a one-off pull instead of waiting for the next document? `createPolicyUpdate({
payer_id, period, extraction_schema_id })` requests a single payer + period run on demand;
`getPolicyUpdate()` / `listPolicyUpdates()` report its lifecycle
(`processing` → `retry` → `succeeded` / `review_required` / `failed`), and
`listPolicyUpdatePackages()` lists the monthly PDF + manifest rollup each payer/period is packaged
into. This is the schema-bound successor to the free-text bulletin methods (`listBulletins()`,
`getBulletin()`), which are soft-deprecated but keep working.

`check()` is what you call next, right before an agent acts on a fact this loop delivered — it is
covered in the next section.

> **0.6 was a breaking release.** Nine MCP tools collapsed to seven (before later portfolio/policy-update tools landed). The whole verification
> surface collapsed to one call. Every removed endpoint now answers a structured
> `410 {"error":"tool_retired","replacement":"/v1/check"}`, and the clients translate that into an
> error that names `check` by name. See [Migrating from 0.5](#migrating-from-05).

## Optional: verify before an agent acts

`check()` is not required to keep facts current — the webhook loop above does that — but it is the
call to make right before an agent relies on one, because it re-derives the verdict from current
state and hands back a signed receipt:

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const result = await kaval.check({
  action: "Approve this prior-authorization request at the in-network rate",
  context: "payer: Aetna; CPT 12345; plan HMO",
  materiality: "critical",
});

if (result.decision !== "ALLOW") {
  // REVIEW is never permission to act.
  holdForHuman(result.facts.filter((fact) => fact.status !== "holds"));
}
```

```py
import os

from kaval import KavalClient

kaval = KavalClient(api_key=os.environ["KAVAL_API_KEY"])
result = kaval.check(action="Approve this prior-authorization request at the in-network rate")
if result["decision"] != "ALLOW":
    hold_for_human(result["facts"])
```

What comes back:

| field          | meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `decision`     | `ALLOW` (every material fact holds on fresh evidence) · `REVIEW` · `BLOCK`                           |
| `reason_codes` | why, from a closed eight-code taxonomy                                                               |
| `facts[]`      | one row per fact: `status` (`holds`/`changed`/`unknown`), `materiality`, and the sources it rests on |
| `receipt`      | `{ id, signature, signed_at }` — fetch the full signed document with `getReceipt(id)`                |
| `latency_ms`   | `{ compile, lookup, live, total }`                                                                   |

A check on facts a watched source already covers is a database read: no model call, no fetch,
nothing on the wire. A **cold** check does live research before it answers — search, fetch, adjudicate —
and the server lets that run for up to 100s by default, so give the call room. `mode: "fast"`
(equivalently `max_wait_ms: 0`) skips research entirely and reports anything it could not settle as
`unknown`, which is `REVIEW`.

The decision table is published, so the receipt's fact list re-derives the verdict offline, and the
Ed25519 public keys are served unauthenticated at `GET /v1/proof-verification-keys/:kid` — checking a
receipt needs no Kaval account and no API key.

The verifier that does it for you ships **inside the SDK**: `@usekaval/kaval/verify` is a
dependency-free subpath export of `@usekaval/kaval`, and the same package ships a
`kaval-receipt-verify` CLI. Neither needs a Kaval account, an API key, or Kaval's database; the only
request either can make is for the public keyset, and that request is optional. Hand it a receipt and
a keyset. It answers three questions by default and one optional verdict question:

1. **Cryptographic validity** — does the Ed25519 signature cover the exact canonical unsigned bytes?
2. **Key trust** — is that `key_id` active or benignly retired, rather than revoked or compromised?
3. **Freshness** — `fresh`, `recheck_due`, `expired`, `not_yet_issued`, or `unknown`.
4. **Verdict derivation** — does the receipt's fact list produce its stated verdict and reason codes?

A valid signature proves who sealed those exact bytes. It does not prove the claim is still true, or
that the key is still trusted, which is why the three answers never collapse into one boolean.

```ts
import {
  extractReceipt,
  parseJsonStrict,
  verifyReceipt,
} from "@usekaval/kaval/verify";

const receipt = extractReceipt(parseJsonStrict(receiptText));
const result = verifyReceipt(receipt, parseJsonStrict(keysetText), {
  derive_verdict: true,
});

result.cryptographic.valid; // the signature covers these exact canonical bytes
result.key.trusted; // the signing key is not revoked or compromised
result.freshness.status; // separate fact — a check receipt carries no expiry, so `unknown`
result.decision?.matches; // the published table reproduced the verdict and reason codes
```

```bash
# Reproducible audit: archive the keyset beside the receipt and stay entirely offline.
npx -p @usekaval/kaval kaval-receipt-verify verify receipt.json --keyset keys.json
npx -p @usekaval/kaval kaval-receipt-verify verify receipt.json --keyset keys.json --derive-verdict

# Or resolve the key over HTTPS from the unauthenticated endpoint.
npx -p @usekaval/kaval kaval-receipt-verify verify receipt.json \
  --key-url https://api.usekaval.com/v1/proof-verification-keys
```

Exit `0` means the signature is valid and the key is trusted; a stale receipt still exits `0`,
because freshness is a separate fact — pass `--require-fresh` to make anything but `fresh` non-zero.
Exit `1` is a completed but unaccepted verification, `2` an input, I/O, or discovery failure. Parse
untrusted receipt text with `parseJsonStrict`, not `JSON.parse`: duplicate members and lossy numbers
are evidence, and `JSON.parse` throws that evidence away before any verifier can see it.

## Keep it warm: watch the sources

A check is a database read when the facts it needs are already backed by a watched source, and a
bounded research run when they are not. Registering the _name_ of an authority is usually enough:

```ts
await kaval.addSource({
  kind: "entity",
  name: "Aetna",
  intent: "payer policy bulletins",
});
```

Kaval resolves that to the pages that publish it, polls them adaptively (slower when nothing
changes, faster when it does), and re-evaluates the dependent facts when they move. `kind: "url"`
watches one page; `kind: "push"` is a document your own system sends in with `sendEvent()`. You do
not have to register first — a source a check cites is auto-watched — but registering ahead of time
is what makes the _first_ check on a fact fast.

Naming an entity is what enqueues the discovery that works out _how_ to acquire the pages behind it.
A `kind: "url"` source registered directly does not get one, so `recompileSource(id)` is how you ask
for one — and it is also the only way back once a source's acquisition plan breaks. It answers `202
{ source_id, job_id, created }`; `created: false` means an open job already covered it.

## Close the loop: subscribe to deltas

Watching is only half of it. Subscribe to `fact_state.delta` and Kaval pushes you what changed and
what it flipped, instead of you discovering it on the next check:

```ts
const { webhook_verification } = await kaval.subscribeFactStateDeltas({
  callback_url: "https://your-app.example.com/hooks/kaval",
  external_scope_ids: ["plan:HMO"], // optional filter
});
// Store webhook_verification.secret — it is shown exactly once, and it is how you
// authenticate every inbound delivery.
```

Each delivery names the source, the old and new content hashes, a diff summary, and the facts whose
state changed — `{fingerprint, text, old_state → new_state, basis}` — plus a pointer to the receipt
covering the re-evaluation. Manage subscriptions with `listWebhooks()`, `setWebhookEnabled()`,
`deleteWebhook()`, and re-drive a dead letter with `replayWebhookDelivery()`.

## Push your own documents

For documents Kaval cannot fetch — a contract, an internal policy, a customer upload — push the new
version and let the background loop do the rest:

```ts
const { changed, facts_pending_review } = await kaval.sendEvent({
  namespace: "contracts",
  document_id: "msa-2026-07",
  content: extractedText,
  scope_keys: ["contract:msa-2026-07"],
});
```

Kaval diffs it against the previous version, marks the dependent facts stale, re-evaluates them, and
emits the delta webhook. Checks that land mid-re-evaluation honestly return `REVIEW`.

## MCP

```bash
KAVAL_API_KEY=kv_live_… npx -y @usekaval/mcp
```

Thirty-one tools run over stdio. They cover checks, receipts, contracts, bulk imports, policy
updates (extraction schemas, runs, monthly packages), the soft-deprecated bulletin tools, training
review, watched sources, outcomes, and the deprecated `verify` alias.

Eleven JSON resources expose contract issues, bulletin extraction status, and the prior read models.
Explicit consent is available, but model promotion and bulletin requeue remain internal. See [packages/mcp](packages/mcp).

MCP clients cancel a tool call well before 100s, so the server narrows `check`'s research budget to
fit inside that envelope instead of inheriting the full default. A cold check over MCP therefore
comes back `REVIEW` more often than the same call through an SDK — register the sources it depends
on and the warm path removes the difference.

## Migrating from 0.5

Everything below folded into `check`. The old routes answer `410 tool_retired`; the clients raise
`KavalRetiredError` (Node) / `KavalRetiredError` (Python) naming the replacement, and the MCP server
returns `{"error":"tool_retired"}` with a message telling the agent to call `check`.

### MCP tools

| 0.5 tool                        | 0.6                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `currentness_check`             | `check` — `{ action }` or `{ claims: ["…"] }`                                       |
| `currentness_verify`            | `check` — branch on `decision === "ALLOW"` instead of `act`                         |
| `currentness_extract_and_check` | `check` — pass the paragraph as `action`/`context`; Kaval compiles the facts itself |
| `currentness_scan_store`        | `check` — `{ claims: [...] }`, up to 20 per call                                    |
| `currentness_monitor`           | `add_source` + a `fact_state` webhook subscription — deltas are pushed, not swept   |
| `proof_audit`                   | `check` — the receipt **is** the proof; `get_receipt` fetches it in full            |
| `proof_gate`                    | `check` — the warm path re-checks from stored state; nothing to re-apply separately |
| `report_outcome`                | `report_outcome` (unchanged; pass `receipt.id`)                                     |
| `verify`                        | `verify`, now deprecated → move to `check`                                          |

### Node / Python methods

| 0.5                                                 | 0.6                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `audit()`, `gate()`, `gateAction()`/`gate_action()` | `check()`                                                                  |
| `check(belief)` / `check(belief=…)`                 | `check({ action })` / `check(action=…)`                                    |
| `verifyBelief()` / `legacy_verify_belief()`         | `check({ action, context })`                                               |
| `extractAndCheck()` / `extract_and_check()`         | `check({ action: theText })`                                               |
| `scanStore()` / `scan_store()`                      | `check({ claims: [...] })`                                                 |
| `monitor()`                                         | `addSource()` + `subscribeFactStateDeltas()`                               |
| `kaval()` / `kavalBatch()` / `kaval_batch()`        | `check({ claims: [{subject, predicate, object, scope}] })`                 |
| `verify()`                                          | `verify()`, deprecated → `check()`                                         |
| —                                                   | new: `getReceipt`, `listSources`, `recompileSource`, `sendEvent`, webhooks |
| `ProofNotFoundError` / `KavalProofNotFoundError`    | removed with `/v1/gate`                                                    |

### Verdict mapping

| 0.5 belief status                              | 0.6                                                 |
| ---------------------------------------------- | --------------------------------------------------- |
| `current` + `act: true`                        | `decision: "ALLOW"`, every fact `holds`             |
| `stale` / `contradicted`                       | fact `changed` → `REVIEW` or `BLOCK` by materiality |
| `unsupported` / `insufficient` / `conflicting` | fact `unknown` → `REVIEW` (`BLOCK` if critical)     |

## Idempotency

Contract mutations, fact imports, extraction schema creation, policy-update run creation, deprecated
`verify()`, and webhook creation carry an `Idempotency-Key`. The client generates a key when you omit
one.

A check reads current state. The server does not replay it, so a retry recomputes the result.

## API origin env vars

Two names exist on purpose — they are **not** interchangeable:

| Consumer                          | Variable         | Reads env?                    |
| --------------------------------- | ---------------- | ----------------------------- |
| Python SDK / MCP                  | `KAVAL_BASE_URL` | yes                           |
| Node `@usekaval/kaval`            | —                | pass `baseUrl` in constructor |
| Marketing site proxy (`apps/web`) | `KAVAL_API_URL`  | yes (server only)             |

Use the same origin value in both vars when self-hosting (e.g. `http://localhost:8787`, the port the
server image listens on). The self-host guide ships with the server distribution rather than here —
Kaval's core repo is private, so there is no public link to give you.

## Honest boundaries

Demo results carry no organizational authority; a production `ALLOW` requires a customer-bound
action policy and applicable empirical calibration; **`REVIEW` is never permission to act**.

## Development

```bash
pnpm install
pnpm check        # build + lint + typecheck + test (the JS packages)
pnpm check:docs   # this README and the CHANGELOG against the shipped surface

# Python SDK
cd sdks/python && pip install -e ".[dev]" && pytest
```

Everything above is hermetic: it fakes the API, which is why a client that aborts its own headline
call, or an endpoint that 404s, can pass it. Two suites talk to a real server, and both skip
themselves when their credentials are absent:

```bash
export KAVAL_API_KEY=kv_live_…
export KAVAL_BASE_URL=https://api.usekaval.com   # or http://localhost:8787

pnpm --filter @usekaval/mcp exec vitest run test/live-tools.test.ts
cd sdks/python && pytest tests/test_live.py
```

These need a running Kaval server and an issued API key, so they are opt-in and self-skip without
one. They are **not** a release gate here: this repository cannot reach the server's source, and
there is no staging deployment — the only deployment is production, and pointing a publish gate at
it would write test sources, receipts and outcome reports into the live product on every tag.

The real client-vs-server contract test lives in the Kaval server repository's CI, where a real
Postgres and the server both exist. It boots the server, issues a scoped key, and drives these same
clients against it on every push. Publishing from this repository gates on the hermetic suites,
which is what this repository can honestly verify on its own.

## License

[Apache-2.0](LICENSE).
