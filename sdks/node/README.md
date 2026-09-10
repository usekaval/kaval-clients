# @usekaval/kaval

The primary loop: **watch a source → extract structured records against a schema → get pushed a
`policy_update.*` webhook as documents land.** Register what Kaval should watch with `addSource()`,
bind an `ExtractionSchema` to it, and subscribe once — no polling, no re-reading a bulletin feed to
find out what changed.

```
addSource()  →  createExtractionSchema() + updateSource()  →  subscribePolicyUpdates()
   (watch)              (what to extract)                       (get pushed the result)
```

Before an AI agent acts, it can also send Kaval the action directly: `check()` identifies the facts
that action depends on, checks them against the sources Kaval watches, and answers `ALLOW`,
`REVIEW`, or `BLOCK` with a signed receipt. Policy engines decide whether an action is permitted
under the rules; Kaval verifies whether the facts those rules depend on are still true.

```bash
npm install @usekaval/kaval
```

> **0.6 is a breaking release.** `audit`, `gate`, `verifyBelief`, `extractAndCheck`, `scanStore`,
> `monitor`, `kaval`, and `kavalBatch` are gone — they all collapsed into `check()`. The old routes
> answer `410 tool_retired`, which this client raises as `KavalRetiredError`. See
> [Migrating from 0.5](#migrating-from-05).

## Node and module format

This package is **ESM-first** (`"type": "module"`). Use `import` in ESM projects, or dynamic import
in CommonJS:

```js
const { Kaval } = await import("@usekaval/kaval");
```

**CJS `require("@usekaval/kaval")`** needs Node **≥20.19** or **≥22.12** (Node’s native
`require(esm)` support). On Node 18, use `import` / `await import()` instead — `engines.node` is
`>=18` for ESM + `fetch`, not for CJS require.

Three entry points, one zero-dependency package:

| Import                             | What it is                                                            |
| ---------------------------------- | --------------------------------------------------------------------- |
| `@usekaval/kaval`                  | the API client — `check()` and everything that configures it          |
| `@usekaval/kaval/verify`           | the offline verifier — receipts + webhook signatures, no network code |
| `@usekaval/kaval/verify/discovery` | live HTTPS key discovery, kept separate so the network choice is loud |

It also installs one command, `kaval-receipt-verify`. See
[`/verify`](#verify--the-offline-verifier).

## check() — the one call

```ts
import { Kaval } from "@usekaval/kaval";

const kaval = new Kaval({ apiKey: process.env.KAVAL_API_KEY });

const result = await kaval.check({
  action: "Issue Acme a $12,000 refund",
  context: "billing record acme-2026 says the contract allows it",
  materiality: "critical",
});

if (result.decision !== "ALLOW") {
  // REVIEW is never permission to act.
  const moved = result.facts.filter((fact) => fact.status !== "holds");
  throw new Error(`blocked on: ${moved.map((f) => f.text).join("; ")}`);
}
```

Already know which facts matter? Name them and skip extraction entirely — structured claims
canonicalize straight to a fingerprint, so there is no model call at all on the compile step:

```ts
const result = await kaval.check({
  claims: [
    {
      subject: "Acme",
      predicate: "refund_eligibility_window_days",
      object: 90,
      scope: { contract: "acme-2026" },
      materiality: "critical",
    },
    "Acme's vendor security attestation is unexpired",
  ],
  mode: "fast",
});
```

### What comes back

```ts
result.decision; // "ALLOW" | "REVIEW" | "BLOCK"
result.reason_codes; // ["ALL_FACTS_HOLD"] | ["FACT_CHANGED"] | …  (a closed set of 8)
result.facts; // [{ fingerprint, text, status, materiality, served_from_state,
//    last_verified_at, sources: [{ locator, version_sha256, fetched_at }] }]
result.receipt; // { id, signature, signed_at }
result.latency_ms; // { compile, lookup, live, total }
```

- **ALLOW** — every material fact still holds on a fresh basis. Safe to act.
- **REVIEW** — something is `unknown`, mid-re-evaluation, or `changed` at low/medium materiality.
  Never permission to act.
- **BLOCK** — a high/critical fact `changed`, or a critical fact is `unknown`.

Per-fact `status` is `holds` | `changed` | `unknown`, so you can see exactly _which_ belief moved
rather than just that something did.

### Options

| option        | meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `action`      | what you are about to do, in plain language (required unless `claims` is given)                  |
| `context`     | what you already believe that bears on it — the retrieved chunk, the cached field                |
| `claims`      | check these facts directly: plain sentences or `{subject, predicate, object, scope}` (max 20)    |
| `mode`        | `"standard"` (default, may research) or `"fast"` (stored state only)                             |
| `max_wait_ms` | live-research budget, default 100000, max 100000; 0 disables research (what `mode: "fast"` sets) |
| `origin_urls` | authoritative sources for this action (max 20), merged with what the workspace watches           |
| `materiality` | `low` \| `medium` \| `high` \| `critical`                                                        |
| `as_of`       | RFC 3339 cutoff for what the action may rely on                                                  |

The default is "let the research finish": a cold check has to search, fetch and adjudicate several
novel facts, and that routinely takes 50–100s. Lower `max_wait_ms` only when you would rather have a
bounded `REVIEW` than an answer — a fact that misses the budget comes back `unknown`. Do not count
on the detached remainder warming the next call: the next check recompiles the action and asks about
different fingerprints. What makes a check warm is a **watched source** (below), and warm checks are
a database read: zero model calls, zero fetches.

The three numbers are exported, so you can bound your own inputs against the server's:

```ts
import {
  MIN_CHECK_MAX_WAIT_MS, // 0      — disables research, same as mode: "fast"
  DEFAULT_CHECK_MAX_WAIT_MS, // 100000 — what the server applies when you omit it
  MAX_CHECK_MAX_WAIT_MS, // 100000 — equal to the default; you can only ask for less
} from "@usekaval/kaval";
```

### The receipt

```ts
const receipt = await kaval.getReceipt(result.receipt.id);
```

Returned exactly as signed. Because the decision table is published, the receipt's own fact list
re-derives the verdict offline, byte for byte, with no server — verify the Ed25519 signature with
[`@usekaval/kaval/verify`](#verify--the-offline-verifier), which ships inside this package.

Each fact carries its `basis`: the sources it was proved against. When a basis entry has a
`version_sha256`, it also names what that digest covers — `version_sha256_of: "canonical_text"` (the
extracted text, with `parser_name` / `parser_version` naming the extractor) or `"raw_bytes"` (the
document as fetched). A PDF has both and they differ, so re-hash the artifact the label names. All
three labels are inside the signed bytes, so a rewritten one fails verification.

## Contract portfolio

The portfolio methods ingest contracts, review extracted claims, and seed approved facts.

```ts
const contract = await kaval.createContract({
  external_id: "agreement-2026-001",
  title: "2026 payer agreement",
  document_type: "base_agreement",
  authority_status: "signed",
  contract_family_key: "payer-hospital-001",
  effective_from: "2026-01-01",
  effective_to: null,
  supersedes_contract_id: null,
  source: {
    kind: "canonical_text",
    content: "Claims must be filed within 120 days.",
  },
});

const status = await kaval.getContract(contract.id);
if (status.extraction_review_state === "issues_present") {
  const issues = await kaval.listContractExtractionIssues(contract.id, {
    issueCode: "evidence_quote_not_exact",
    limit: 100,
  });
  sendToContractReviewer(issues.data);
}
const candidates = await kaval.listContractClaims(contract.id, {
  status: "proposed",
  limit: 100,
});

await kaval.reviewContractClaim(contract.id, candidates.data[0].id, {
  review_id: "review-2026-001",
  decision: "approve",
  expected_candidate_version: candidates.data[0].candidate_version,
});
```

`ContractResource` includes `extraction_issue_count` and `extraction_review_state`.

Use `createContractUpload()` before you ingest a private PDF. The API returns a private upload target.

Use `createFactImport()` to queue approved facts. One import can contain 400 items.

The worker processes each import in groups of 20. Each item gets a separate result.

Use `listBulletins()` for structured bulletin records. Each page can contain 100 records.

Use `listBulletinExtractionAttempts()` to read extraction status and failures. Use
`getBulletinExtractionAttempt()` to read one source version. These methods cannot requeue work.

> **Soft-deprecated.** Bulletins are the free-text predecessor of [Policy updates](#policy-updates):
> bind an `ExtractionSchema` to a source instead and read `listPolicyUpdates()` /
> `policy_update.document` webhooks for the same information, structured. The bulletin methods keep
> working.

Use `listTrainingJobs()` for read-only training status. The SDK does not expose model promotion.

Use `listTrainingFeedback()` to review eligible feedback. It supports `effectiveTrainingUse`,
`cursor`, and `limit` filters.

Use `recordTrainingFeedbackConsent()` to approve or withhold one feedback item. Approval requires explicit consent.

Both feedback methods require an API key with the explicit `training:manage` scope.

The SDK exports all portfolio types, scope names, status names, issue codes, and frozen limits.

## `/verify` — the offline verifier

```ts
import { verifyReceipt, verifyWebhookSignature } from "@usekaval/kaval/verify";
```

Everything Kaval signs, checked without Kaval: the Ed25519 **receipt** a check returns, and the HMAC
**webhook signature** on an inbound `fact_state.delta` ([worked example](#verifying-a-delivery)).

The subpath is the whole verifier: zero dependencies, and **nothing in its import graph touches the
network** — no `fetch`, no `node:http`, no sockets, transitively. That is enforced by a test that
walks the real module graph of both the source and the shipped `dist`, so "offline" is a checked
property rather than a promise. It never reads an API key and never contacts Kaval, which is what
makes it something you can hand to a counterparty who does not trust us.

### Receipts

`verifyReceipt` answers three questions by default. It answers a fourth question when you set
`derive_verdict: true`:

1. **Cryptographic validity** — does the Ed25519 signature cover the exact canonical unsigned bytes?
2. **Key trust** — is the immutable `key_id` active or benignly retired, or revoked/compromised?
3. **Freshness** — at the instant you name, is the receipt `fresh`, `recheck_due`, `expired`, or
   `not_yet_issued`?
4. **Verdict derivation** — does the receipt's fact list produce its stated verdict and reason codes?

A valid signature proves who sealed these exact bytes. It does not prove the claim is true, that its
evidence is still current, or that the key is still trusted. `accepted` means signature **and** key
trust; freshness is reported alongside and never gates it.

```ts
import {
  extractReceipt,
  parseJsonStrict,
  verifyReceipt,
} from "@usekaval/kaval/verify";

// Accepts a bare receipt, `{ packet }`, or the `{ run: { packet } }` share wrapper.
const receipt = extractReceipt(parseJsonStrict(receiptText));
const keyset = parseJsonStrict(keysetText);

const result = verifyReceipt(receipt, keyset, {
  at: "2026-07-20T12:00:00.000Z",
  derive_verdict: true,
});

result.cryptographic.valid; // the bytes really were signed by this key
result.key.lifecycle_status; // "active" | "retired" | "revoked" | "compromised" | "unknown"
result.key.trusted;
result.freshness.status; // "fresh" | "recheck_due" | "expired" | "not_yet_issued" | "unknown"
result.decision?.matches; // the published table reproduced the verdict and reason codes
result.accepted; // the signature, key trust, and requested verdict derivation passed
```

Use `parseJsonStrict` (or `verifyReceiptText`, which does it for you) on anything that arrives as
untrusted JSON **text**. Plain `JSON.parse` silently discards duplicate-member and lossy-number
evidence before any object-level verifier can see it.

Exported: `verifyReceipt` · `verifyReceiptText` · `extractReceipt` · `verifyWebhookSignature` ·
`decideCheck` · `deriveCheckDecision` · `deriveCheckDecisionV2` ·
`parseCheckReceiptV2DecisionFields` · `checkDecisionInputFromReceipt` ·
`parseJsonStrict` · `stableCanonicalJson` · `canonicalUnsignedReceiptJson` ·
`canonicalUnsignedReceiptBytes` · `parseVerificationKey` · `verificationKeyFromDocument` ·
`isRfc3339Timestamp` · `parseRfc3339Instant` · `rfc3339TimestampMilliseconds` ·
`rfc3339TimestampNanoseconds` · `KAVAL_CANONICALIZATION` · `MAX_JSON_NUMBER_CHARACTERS` ·
`CHECK_DECISION_RULE_V2_VERSION` · `CHECK_RECEIPT_V2_VERSION` ·
`WEBHOOK_SIGNATURE_VERSION` · `WEBHOOK_SIGNED_CONTENT` · `DEFAULT_WEBHOOK_TOLERANCE_SECONDS`.

Both documents Kaval signs verify here: a ProofPacket, whose signature block is
`{algorithm, key_id, signature}`, and a `/v1/check` receipt, which adds `signed_at`. That block is a
closed allowlist — those four members and nothing else — so an appended field fails closed instead of
shadowing the algorithm or key a lax verifier reads. Nothing _inside_ the block is covered by the
signature (canonicalization strips the whole block before hashing), so `signed_at` is authenticated
indirectly, by being required to equal the signed `checked_at`. A check receipt carries no `expiry`,
so its freshness is honestly `unknown`.

### Fetching keys

`verifyReceipt` takes a key document you already hold — archive the keyset next to the receipt and
the verification is reproducible forever. If you would rather fetch it live, that is a **separate**
subpath, precisely so choosing the network is explicit:

```ts
import { discoverVerificationKeyDocument } from "@usekaval/kaval/verify/discovery";

const keys = await discoverVerificationKeyDocument(
  "https://api.usekaval.com/v1/proof-verification-keys",
  keyId,
);
```

Discovery is bounded to 5s and 256 KiB, requires HTTPS, refuses redirects and URL credentials, and
allows plain HTTP only for loopback when you pass `allow_http_loopback`.

### CLI: `kaval-receipt-verify`

Installing this package installs the verifier as a command, so a counterparty can check a receipt
without writing any code:

```bash
npx --package @usekaval/kaval kaval-receipt-verify verify receipt.json --keyset keys.json
```

```
Usage:
  kaval-receipt-verify verify <receipt.json|-> --keyset <keys.json> [options]
  kaval-receipt-verify verify <receipt.json|-> --key-url <https-url> [options]

Options:
  --keyset <path>            Offline per-key document or keyset (recommended for reproducibility)
  --key-url <url>            HTTPS per-key endpoint or keyset endpoint
  --at <RFC3339>             Evaluate freshness at an explicit time
  --require-fresh            Exit non-zero unless freshness is "fresh"
  --derive-verdict           Re-derive the check verdict and require it to match
  --allow-http-loopback      Permit http://localhost/127.0.0.0/8/::1 for local development
  --compact                  Emit compact JSON
  -h, --help                 Show this help
```

It prints the full `VerificationResult` as JSON and takes the receipt from a file or `-` (stdin).
**Exit `0`** means the signature is valid and the key is trusted — an expired receipt still exits
`0`, because freshness is a different question. Add `--require-fresh` to require fresh evidence.
Add `--derive-verdict` to require the stated verdict to match the published decision table.
**Exit `1`** is a completed verification that was not accepted. **Exit `2`** is an input, I/O, or
discovery failure.

`--at` and every receipt/key timestamp must be a component-valid RFC 3339 instant. Date-only
strings, impossible calendar days (`2026-02-29`), leap-second `:60`, and the `-00:00`
unknown-local-offset marker fail closed rather than being normalized by `Date.parse`, and freshness
comparisons keep all nine fractional-second digits as exact epoch nanoseconds.

### Security boundary

- Key IDs are immutable and never reused across keys or algorithms; one public key may not appear
  under two IDs.
- Only canonical, unpadded base64url Ed25519 public keys (32 bytes) and signatures (64 bytes) pass.
- Duplicate JSON keys, unsafe integers, lossy decimal/exponent spellings, sparse or non-JSON values,
  excessive nesting, oversized documents, redirects, unknown key IDs, and algorithm confusion all
  fail closed.
- `retired` is benign rotation: historical signatures still verify.
- `revoked` and `compromised` stay mathematically checkable but never yield `key.trusted: true` — a
  compromised signer can backdate its own `issued_at`, so no self-asserted timestamp rescues them.

## Keep it warm: watched sources

```ts
// Registering the NAME of an authority is usually enough.
const { source, resolved, authority } = await kaval.addSource({
  kind: "entity",
  name: "Aetna",
  intent: "payer policy bulletins",
});

await kaval.listSources(); // includes sources auto-registered by a check
await kaval.listSources({ includeInactive: true });
await kaval.pauseSource(source.id); // stop polling without forgetting it
await kaval.resumeSource(source.id);
await kaval.deleteSource(source.id);
await kaval.getSource(source.id);
await kaval.recompileSource(source.id); // re-derive how Kaval fetches and parses it
```

`kind`: `url` (one page) · `entity` (a name to resolve) · `push` (a document you send in) ·
`connection` (a configured system of record). Kaval polls adaptively — slower when nothing changes,
faster when it does — and re-evaluates the facts that depend on a source when it moves.

`authority` is the resolver's working — one `{url, outcome, reason}` per candidate it considered.
`accepted` and `discarded` are informational; **`ambiguous` is the one to act on**: a real page of
the real entity, governing a different product line with different rules. Kaval refuses to guess
which of those you meant, so add or reject them yourself:

```ts
for (const decision of authority ?? []) {
  if (decision.outcome === "ambiguous") {
    console.warn(`ambiguous: ${decision.url} — ${decision.reason}`);
  }
}
```

`discovery_error` is set when the source registered but Kaval could not derive an acquisition plan
for it. `recompileSource(id)` re-runs that derivation — it is the recovery path from a broken plan,
and the way a directly-registered `kind: "url"` source gets a plan at all. It answers `202` with a
`job_id` because discovery runs on the worker, not in your request.

## Policy updates

Register a JSON Schema and bind it to a source; every document that lands on that source afterward
is extracted against it and delivered as a `policy_update.document` webhook, with per-payer monthly
rollups delivered as `policy_update.monthly_package`. On each document event, `extraction_run.period`
is the publication / newsletter month (`YYYY-MM`); sections and `extraction.record_evidence` may
include normalized `page` / `bbox` for PDF highlighting; `result.payer_name` is the human brand
beside the stable `payer_id` slug.

```ts
const schema = await kaval.createExtractionSchema({
  name: "prior-auth-changes",
  json_schema: {
    type: "object",
    properties: {
      cpt_code: { type: "string" },
      requires_prior_auth: { type: "boolean" },
    },
    required: ["cpt_code", "requires_prior_auth"],
  },
});

await kaval.updateSource({ id: source.id, extraction_schema_id: schema.id });
// extraction_schema_id: null unbinds it, leaving the source watched but unextracted.
```

Prefer a one-off run over waiting for the next document? `createPolicyUpdate()` requests a payer +
period extraction run directly against a bound schema:

```ts
const run = await kaval.createPolicyUpdate({
  payer_id: "aetna",
  period: "2026-08",
  extraction_schema_id: schema.id,
});
// 202, run.status: "processing" — poll getPolicyUpdate(run.id) or wait for the webhook.

await kaval.listPolicyUpdates({ payer_id: "aetna", period: "2026-08" });
await kaval.getPolicyUpdate(run.id);
await kaval.listExtractionSchemas();
await kaval.getExtractionSchema(schema.id);
```

Each payer + period's runs roll up into one monthly PDF + manifest:

```ts
const packages = await kaval.listPolicyUpdatePackages({ payer_id: "aetna", period: "2026-08" });
const pkg = await kaval.getPolicyUpdatePackage(packages[0]!.id);
// pkg.pdf_href → GET /v1/policy-update-packages/{id}/document → 302 signed PDF (follow redirects).
```

Read the canonical text (or heading-bounded sections) a source version was extracted from directly,
independent of any bound schema:

```ts
const { content } = await kaval.getSourceVersionContent(sourceVersionId);
const { sections } = await kaval.getSourceVersionContent(sourceVersionId, {
  format: "sections",
});
```

Subscribe once, the same way as `fact_state.delta`:

```ts
const { subscription, webhook_verification } =
  await kaval.subscribePolicyUpdates({
    callback_url: "https://your-app.example.com/hooks/kaval",
    external_scope_ids: ["payer:aetna"], // optional scope filter
  });
```

`createExtractionSchema()` and `createPolicyUpdate()` require an API key with `policy-update:manage`;
the read methods above accept `policy-update:read` or `verification:execute`.

## Close the loop: `fact_state.delta` webhooks

Watching only helps you if you hear about it. Subscribe once, at deploy time:

```ts
const { subscription, webhook_verification } =
  await kaval.subscribeFactStateDeltas({
    callback_url: "https://your-app.example.com/hooks/kaval",
    external_scope_ids: ["contract:acme-2026"], // optional scope filter
  });
// webhook_verification.secret is shown EXACTLY ONCE — store it; it is how you
// authenticate every inbound delivery (hmac-sha256 over the standard webhook headers).
```

Each delivery is a `FactStateDeltaEvent`: the source, `old_version_sha256 → new_version_sha256`, a
diff summary, and the facts whose state changed (`{fingerprint, text, old_state → new_state,
basis}`), plus a pointer to the receipt covering the re-evaluation.

### Verifying a delivery

Your callback URL is a public HTTPS endpoint, and a delta is an instruction worth forging — "a fact
your agent relies on just flipped". `verifyWebhookSignature` is the receiving half of Kaval's
signature: HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw body>`, compared in constant time.

```ts
import express from "express";
import type { FactStateDeltaEvent } from "@usekaval/kaval";
import { verifyWebhookSignature } from "@usekaval/kaval/verify";

// webhook-key-id → that generation's secret. During a rotation overlap BOTH generations sign real
// deliveries, so hold both here and the rollover is a config change instead of an outage.
const secrets = {
  [process.env.KAVAL_WEBHOOK_KEY_ID!]: process.env.KAVAL_WEBHOOK_SECRET!,
};
const seen = new Set<string>(); // illustrative; a real receiver dedupes in its database

const app = express();

// express.raw, NOT express.json: the signature covers the exact bytes on the wire. A body that has
// been parsed and re-serialised has a different MAC, and no genuine delivery would ever verify.
app.post(
  "/hooks/kaval",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const result = verifyWebhookSignature({
      body: req.body, // Buffer, untouched
      headers: req.headers,
      secrets,
      toleranceSeconds: 300, // default; the replay window either side of now
    });
    if (!result.valid) {
      // 400, not 401 — a retry will not make an unsigned request signed. `result.reason` is one of
      // missing_header · malformed_timestamp · unknown_key_id · unsupported_signature_version ·
      // malformed_signature · signature_mismatch · timestamp_out_of_tolerance, and is safe to log.
      return res.status(400).json({ error: result.reason });
    }

    // Delivery is at-least-once by design: a retry after your 500 is a legitimate duplicate. Dedupe
    // on result.webhookId (the event's own id) before doing anything with side effects.
    if (seen.has(result.webhookId)) return res.status(200).end();
    seen.add(result.webhookId);

    const event = JSON.parse(req.body.toString("utf8")) as FactStateDeltaEvent;
    const {
      source,
      old_version_sha256,
      new_version_sha256,
      diff_summary,
      facts,
    } = event.data;

    for (const fact of facts) {
      // "Aetna requires prior auth for CPT 12345" — holds → changed, at critical materiality.
      console.log(
        `${fact.materiality} ${fact.old_state} → ${fact.new_state}: ${fact.text}`,
        `via ${source.locator} (${old_version_sha256?.slice(0, 12)} → ${new_version_sha256.slice(0, 12)})`,
        fact.basis.map((ref) => ref.source_locator),
      );
    }
    void diff_summary; // changed_sections + stats, if you want to show what moved in the document

    // Answer 2xx quickly and do the work after; Kaval retries non-2xx with backoff, then dead-letters.
    res.status(202).end();
  },
);
```

The verifier lives on the `/verify` subpath, so a receiver that never constructs a client pulls in no
HTTP code — and, like the receipt verifier, it never contacts Kaval to decide whether a request is
genuine.

```ts
await kaval.listWebhooks();
await kaval.setWebhookEnabled(subscription.subscription_id, false);
await kaval.deleteWebhook(subscription.subscription_id);

// The delivery log is the only place a delivery id is published — start here, then replay.
const { items, next_before } = await kaval.listWebhookDeliveries(
  subscription.subscription_id,
  { limit: 100 }, // 1–200, default 50; page with `before`
);
for (const delivery of items) {
  if (delivery.state === "dead_letter")
    await kaval.replayWebhookDelivery(delivery.delivery_id);
}

// Roll the signing key; the old generation keeps verifying until `overlap_until`, so you can
// redeploy the receiver without dropping deliveries. The new secret is shown exactly once.
await kaval.rotateWebhookSigningKey(subscription.subscription_id, {
  overlap_until: new Date(Date.now() + 24 * 3_600_000).toISOString(),
});
// createWebhook() is the general form if you need a non-fact_state family.
```

## Push your own documents

```ts
const { changed, facts_pending_review } = await kaval.sendEvent({
  namespace: "contracts",
  document_id: "acme-2026-msa",
  content: extractedText, // or content_url
  scope_keys: ["contract:acme-2026"],
});
```

Kaval stores the version, diffs it against the previous one, marks the dependent facts stale,
re-evaluates them in the background, and fires the delta webhook. `changed: false` means the content
was byte-identical: no version row, no staleness, no delta. Checks that land mid-re-evaluation
honestly return `REVIEW`.

## reportOutcome()

```ts
await kaval.reportOutcome({
  id: result.receipt.id,
  kind: "relied_and_correct",
});
```

Kinds: `relied_and_correct` · `current_later_contradicted` · `stale_caught_real` ·
`stale_was_false_alarm`.

## verify() — deprecated pilot alias

`verify()` checks one load-bearing conclusion against evidence references you supply and returns a
signed ProofPacket receipt. It is kept only while existing pilot integrations migrate and **will be
removed**. New code should call `check()`, which needs no evidence list, is answered from watched
state in milliseconds, and keeps monitoring the facts afterwards.

```ts
const { status, receipt } = await kaval.verify({
  conclusion:
    "The 2024 International Building Code is the current IBC edition.",
  evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
});
```

Each item in `evidence_refs` (1–20 entries) is **either** a plain https URL string **or** a strict
`{ url, document_id }` object; `document_id` values must be unique per request. A bare `{ url }`
object without `document_id` is invalid — pass the plain string instead. The client rejects these
wire-invalid shapes locally before spending a request.

## Errors

| class               | when                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `KavalError`        | any non-2xx. Carries `status`, `payload`, and `idempotencyKey` where one was spent.                                               |
| `KavalRetiredError` | HTTP 410 `tool_retired` — you called a route that folded into `/v1/check`. Exposes `.replacement` and a message naming `check()`. |
| `TypeError`         | locally-detected invalid input, thrown before any network call                                                                    |

## Idempotency and retries

`verify()` is the only method that spends an operation key: it sends a fresh UUID
`Idempotency-Key` and retries once with the same key when the connection fails without a
trustworthy response, or the API says the operation is still being finalized. It does not retry
ordinary API errors, rate limits, or terminal 5xx responses. If both bounded attempts stay
ambiguous, the thrown error exposes `error.idempotencyKey` — pass it back explicitly after your own
delay to resume the same operation instead of counting a second attempt.

`createWebhook()` (and `subscribeFactStateDeltas()` / `subscribePolicyUpdates()`),
`createExtractionSchema()`, and `createPolicyUpdate()` send a key because the API requires one; they
generate it when you do not supply it.

`check()` deliberately sends none: it is a read of current state, so a retry recomputes rather than
replays and cannot double-count.

Every method — `health()` included — accepts a final `{ idempotencyKey?, signal?, timeoutMs? }`. The
constructor defaults to a 150-second deadline; override per call or set `timeoutMs: null` to disable
it. That default matches the API's own handler deadline: a client-side deadline below the server's
research budget does not bound anything, it just aborts your own cold `check()`. To finish sooner,
send a smaller `max_wait_ms` (or `mode: "fast"`) and get a real verdict instead of an `AbortError`.

## Migrating from 0.5

| 0.5                             | 0.6                                                                         |
| ------------------------------- | --------------------------------------------------------------------------- |
| `audit()`                       | `check()` — the receipt **is** the proof                                    |
| `gate()` / `gateAction()`       | `check()` — the warm path re-checks from state; nothing to re-apply         |
| `check(belief)`                 | `check({ action })`                                                         |
| `verifyBelief()`                | `check({ action, context })` — branch on `decision === "ALLOW"`, not `act`  |
| `extractAndCheck({ text })`     | `check({ action: text })` — Kaval compiles the facts itself                 |
| `scanStore({ beliefs })`        | `check({ claims })` — up to 20 per call                                     |
| `monitor({ beliefs, webhook })` | `addSource()` + `subscribeFactStateDeltas()` — deltas are pushed, not swept |
| `kaval()` / `kavalBatch()`      | `check({ claims: [{ subject, predicate, object, scope }] })`                |
| `verify()`                      | `verify()`, deprecated → `check()`                                          |
| `ProofNotFoundError`            | removed with `/v1/gate`                                                     |
| —                               | new: `getReceipt`, source registry, `sendEvent`, webhook subscriptions      |

Status mapping: `current` + `act: true` → `decision: "ALLOW"` with every fact `holds`;
`stale`/`contradicted` → a fact `changed` (`REVIEW` or `BLOCK` by materiality);
`unsupported`/`insufficient`/`conflicting` → a fact `unknown` (`REVIEW`, or `BLOCK` if critical).

## API

`check` · `getReceipt` · `addSource` · `listSources` · `getSource` · `pauseSource` · `resumeSource` ·
`recompileSource` · `deleteSource` · `updateSource` · `getSourceVersionContent` · `sendEvent` ·
`createExtractionSchema` · `getExtractionSchema` · `listExtractionSchemas` · `createPolicyUpdate` ·
`getPolicyUpdate` · `listPolicyUpdates` · `getPolicyUpdatePackage` · `listPolicyUpdatePackages` ·
`subscribePolicyUpdates` · `subscribeFactStateDeltas` · `createWebhook` · `listWebhooks` ·
`setWebhookEnabled` · `deleteWebhook` · `listWebhookDeliveries` · `rotateWebhookSigningKey` ·
`replayWebhookDelivery` · `reportOutcome` · `verify` (deprecated) · `health`.

Construct with `{ apiKey, baseUrl?, fetch?, timeoutMs? }` — `baseUrl` defaults to
`https://api.usekaval.com`. Works in Node 18+, browsers, and edge runtimes (uses the global `fetch`).

Offline verification is a separate surface with no client and no key:
[`@usekaval/kaval/verify`](#verify--the-offline-verifier) — `verifyReceipt` for receipts,
`verifyWebhookSignature` for inbound deliveries — plus the `kaval-receipt-verify` command.

**Env vars:** this package does **not** read `KAVAL_BASE_URL` from the environment — pass
`baseUrl` in the constructor (Python SDK and MCP use `KAVAL_BASE_URL`; the marketing-site proxy
uses `KAVAL_API_URL`). See the [clients README](../README.md#api-origin-env-vars).

## Honest boundaries

Demo results carry no organizational authority. A production `ALLOW` requires a customer-bound
action policy and applicable empirical calibration; `REVIEW` is never permission to act.

The Python client mirrors this surface: `pip install kaval`.
