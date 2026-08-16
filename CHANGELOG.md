# Changelog

All packages in this repo version in lockstep (`scripts/bump.mjs`).

## Unreleased

## 0.7.7 — released 2026-08-16

### Breaking

- **Extraction-domain rename.** Client methods, MCP tools, webhook events, and the create-subscription
  kind no longer use the `policy_update` / `PolicyUpdate` names:
  - Node: `createExtractionRun`, `getExtractionRun`, `listExtractionRuns`, `getExtractionPackage`,
    `listExtractionPackages`, `subscribeExtractions`.
  - Python: `create_extraction_run`, `get_extraction_run`, `list_extraction_runs`,
    `get_extraction_package`, `list_extraction_packages`, `subscribe_extractions`.
  - MCP: `create_extraction_run`, `get_extraction_run`, `list_extraction_runs`,
    `list_extraction_packages`.
  - Events: `extraction.document`, `extraction.package` (were `policy_update.document`,
    `policy_update.monthly_package`).
  - Webhook create kind: `extraction`. `policy_update` is rejected on create; existing
    `policy_update` subscriptions still appear on list.
  - Create/filter field is `publisher_id`. Response payloads may still include `payer_id` as a
    retired alias if a host has not flipped the field.

## 0.7.6 — released 2026-08-13

### Added

- `updateSource` / `update_source` accept optional `reprocess` (default false) to fill-missing re-extract versions that already ran under another schema. The returned source includes `reprocess_queued` when reprocess was accepted. `policy_update.document` `data.source_change` now includes `schema_changed`; match those events to the original extract on `data.source_version_id` (also envelope `correlation_id`). Extraction runs may include `reprocess: true` and `generation`. MCP `update_source` forwards `reprocess` and returns `reprocess_queued`.

## 0.7.5 — released 2026-08-10

### Changed

- **`listPolicyUpdates` / `list_policy_updates` return a page.** Response is now
  `{ extraction_runs, next_cursor, documents? }` instead of a bare run array. Supports
  `period_from` / `period_to`, `created_since` / `updated_since`, `limit`, `cursor`, and
  `expand: "document"` for webhook-parity `PolicyUpdateDocumentData` rows (parallel `documents`,
  `null` for non-document runs). `getPolicyUpdate` / `get_policy_update` accept the same expand.
  MCP `list_policy_updates` returns that page shape directly.

## 0.7.4 — released 2026-08-09

### Changed

- **Source capacity docs (two ceilings).** MCP README / `remove_source` tool text no longer teach a
  single “200 active sources per workspace” bound. Correct model: 200 active `registered`/`resolved`
  per workspace (auto-registered citations count here); 200 active `discovered` children **per
  parent** (do not consume the workspace registered/resolved budget). Only deletion frees a slot.
- **Package PDF download.** Documented that `list_policy_update_packages` rows expose `pdf_href` as
  `GET /v1/policy-update-packages/{id}/document` → **302** to a short-lived signed PDF (follow
  redirects). Node/Python READMEs note the same for `getPolicyUpdatePackage` /
  `get_policy_update_package`.
- **402 fixture vocabulary.** Hermetic tests / comments use `subscription_required` instead of the
  retired `insufficient_balance` / “out of credit” wording. Clients still surface whatever
  `error.code` the API returns.

## 0.7.3 — released 2026-08-07

### Changed

- **Repository metadata follows the org move.** Package homepage / repository / issues URLs now
  point at `usekaval/kaval-clients`, and the MCP registry identity is `io.github.usekaval/kaval`
  (was `io.github.LufeMC/kaval`). No client API changes.

## 0.7.2 — released 2026-08-06

### Added

- **Policy-update provenance fields.** `PolicyUpdateDocumentSection` now optionally carries
  normalized `page` / `bbox` from Parse layout. `policy_update.document` `extraction` may include
  `record_evidence` (parallel to `records`). Documented that `extraction_run.period` is the
  publication / newsletter month (`YYYY-MM`), not PA effective month; `result` may include
  `document_period`, `period_basis`, and `payer_name`. `pdf_href` remains Kaval's durable
  source-version document URL.
- **Policy updates.** The schema-bound successor to free-text bulletins: register a JSON Schema
  with `createExtractionSchema()` / `create_extraction_schema()`, bind it to a watched source with
  `updateSource()` / `update_source()`, and get every document that lands on it extracted
  automatically and delivered as a `policy_update.document` webhook — or request a one-off payer +
  period run with `createPolicyUpdate()` / `create_policy_update()`. Monthly PDF + manifest rollups
  arrive as `policy_update.monthly_package`. `getSourceVersionContent()` /
  `get_source_version_content()` reads the canonical text (or pre-split `sections`) an extraction
  ran against. New scopes `policy-update:read` and `policy-update:manage`; new webhook
  `subscription_kind: "policy_update"` via `subscribePolicyUpdates()` / `subscribe_policy_updates()`.
  Shipped in the Node SDK, the Python SDK, and eight new MCP tools (`create_extraction_schema`,
  `list_extraction_schemas`, `create_policy_update`, `get_policy_update`, `list_policy_updates`,
  `list_policy_update_packages`, `update_source`, `get_source_version_content`). The free-text
  bulletin methods and tools are soft-deprecated but keep working.
- **MCP portfolio surface.** Sixteen tools cover contracts, bulk imports, bulletins, extraction
  failures, training status, feedback review, and consent. Eleven JSON resources expose read models.
  Training execution, model promotion, and bulletin requeue remain internal.
- **Node portfolio surface.** The SDK adds typed contract, claim-review, fact-import, bulletin, and
  training methods. It also exposes extraction issues, bulletin attempts, pagination, and
  `training:manage`. It validates consent and frozen limits before it sends a request.
- **Python policy-updates surface.** Python now exposes extraction schemas, policy-update runs and
  packages, `update_source`, `get_source_version_content`, and `subscribe_policy_updates`, alongside
  checks, watched sources, webhooks, outcomes, and the deprecated verify alias. The broader
  portfolio methods (contracts, fact imports, training) remain Node/MCP-only for now.
- **Decision rule 2.0.0 verification.** The offline verifier re-derives the signed `ALLOW` gate.
  It rejects altered, expired, incomplete, or incorrectly bound calibration fields.

### Changed

- All public package and MCP Registry versions now use 0.7.2. Version 0.7.1 already exists on npm.

## 0.7.1 — released 2026-08-05

### Added

- **The check-decision table ships in `@usekaval/kaval/verify`.** Until now a holder could verify a
  receipt's Ed25519 signature offline but had to run Kaval's server code to re-derive the ALLOW /
  REVIEW / BLOCK it states. The current table is `check-decision/1.1.0`, and the verifier also
  supports receipts issued under `check-decision/1.0.0`. It exports `decideCheck`,
  `deriveCheckDecision`, `checkDecisionInputFromReceipt`, the `CHECK_*` enums, and these one-call
  forms: `verifyReceipt(receipt, keys, { derive_verdict: true })` and
  `kaval-receipt-verify --derive-verdict`.
  - **Additive by construction.** `derive_verdict` is off by default. Without it the result keeps
    the original shape: `scope: "signature_envelope"`, no `decision` block, and acceptance decided
    by signature and key trust alone. With it, `scope` reads
    `"signature_envelope+decision_table"`, a `decision` block appears, and a receipt whose stated
    verdict does not follow from its own facts is **not** accepted.
  - **It re-derives from the evidence, never from the answer.** The input is `facts[]` plus
    `compilation_uncertain`; `decision` and `reason_codes` are reported as `stated` and are never
    read as an input. A receipt missing a discriminator is refused rather than guessed.
  - **Pinned against the issuer.** `check-decision-vectors.json` joins the shared conformance
    vectors, pinned here in `test/verify/mirror-pin.test.ts` and in the issuer copy's
    `mirror-manifest.json`, and executed on both sides. A table that drifted fails one side.

## 0.7.0 — released 2026-07-29

### Fixed

- **`--as-of` removed from the `kaval` CLI.** It parsed a date and sent `as_of`, and the server does
  read that field — but only to stamp the compiler clock and the research contract. It never reaches
  the state lookup, so a dated check and an undated one read the same row and returned the same
  verdict. A flag that looks like point-in-time replay and is a no-op is worse than no flag; it now
  warns on stderr and is ignored, so anyone with it in a script learns why.

### Added

- **`--origin` on `kaval check`**, for documents the caller has already read.
- **The `kaval` binary is published.** 0.6.0 shipped a bin map containing only
  `kaval-receipt-verify`, so `npx @usekaval/kaval` installed a package with no `kaval` command.

## 0.6.0 — released 2026-07-27

The whole verification surface collapses to **one call**. Send Kaval the action an agent is about to
take; it identifies the facts that action depends on, checks them against the sources it watches, and
answers `ALLOW` / `REVIEW` / `BLOCK` with a signed receipt. Everything else in these clients exists to
keep that call warm.

### Breaking

- **MCP: 9 tools → 7.** New surface: `check`, `get_receipt`, `add_source`, `list_sources`,
  `remove_source`, `report_outcome`, and `verify` (deprecated pilot alias). Removed:
  `currentness_check`, `currentness_verify`, `currentness_extract_and_check`,
  `currentness_scan_store`, `currentness_monitor`, `proof_audit`, `proof_gate`.
- **Node/Python: the belief and proof-lifecycle methods are gone.** Removed: `audit`, `gate` /
  `gateAction` / `gate_action`, the belief-shaped `check` / `legacy_verify_belief` / `verifyBelief`,
  `extractAndCheck` / `extract_and_check`, `scanStore` / `scan_store`, `monitor`, `kaval`,
  `kavalBatch` / `kaval_batch`, and `ProofNotFoundError` / `KavalProofNotFoundError`. Also gone:
  `scheduleMonitor`-shaped client-side sweeping — drift is delivered by webhook now, not swept.
- **Server:** every retired route answers `410 {"error":"tool_retired","replacement":"/v1/check"}` on
  every method. Both SDKs raise a typed `KavalRetiredError` naming the replacement; the MCP server
  returns `{"error":"tool_retired"}` with a message telling the agent to call `check`.

See the migration tables in the [root README](README.md#migrating-from-05) and each package README.

### Added

- **`check()` / the `check` tool** — `POST /v1/check`. Takes `{action, context?, claims?, mode?,
max_wait_ms?, origin_urls?, materiality?, as_of?}`; returns `{decision, reason_codes, facts[],
receipt, latency_ms}`. Per-fact `status` (`holds` | `changed` | `unknown`) plus the sources each
  fact rests on, so callers see _which_ belief moved. Structured claims (`{subject, predicate,
object, scope}`) skip extraction entirely. A check is a read of current state, so it carries **no**
  idempotency key — retrying recomputes rather than replays.
- **`getReceipt(id)` / the `get_receipt` tool** — the signed check receipt exactly as signed.
  `check` returns only `{id, signature, signed_at}`; the per-fact basis, `decision_rule_version`,
  `algorithm` and `key_id` live behind this call, and on `BLOCK` it is the artifact that proves the
  verdict. Self-derivable: the published decision table plus the receipt's own fact list re-derive
  the verdict offline.
- **Evidence basis on every receipt fact** — `basis[]` carries `source_locator`, `version_sha256`
  and, critically, `version_sha256_of` (`canonical_text` | `raw_bytes`) with `parser_name` /
  `parser_version`, plus `fetched_at`, `publication_time` and `span_ref`. A PDF's canonical text and
  its raw bytes are two unequal legitimate digests of the same document, so an unlabelled digest is
  decorative — a holder cannot know which artifact to hash. The label travels with the digest or the
  digest is absent. Each fact also carries `method` (`state` | `live` | `timeout`),
  `freshness_failure` (`stale` | `dormant` | `basis_superseded` | `source_unreachable` |
  `ttl_expired`), `stale_pending` and `novel`, so a `REVIEW` says _why_ in the signed document.
- **`@usekaval/kaval/verify`** — the Ed25519 receipt verifier now ships as a dependency-free subpath
  export of the Node SDK, with a `kaval-receipt-verify` CLI. It answers cryptographic validity, key
  lifecycle trust, and freshness as three separate results, verifies against an archived keyset
  (fully offline) or the unauthenticated `GET /v1/proof-verification-keys/:kid`, and touches no Kaval
  database and no API key. Previously it lived only in Kaval's closed core repo, which made the
  offline-verification claim true but not turnkey. It is a subpath rather than a second package
  because both halves are zero-dependency — there is nothing to contaminate — so this is one version
  and one publish job instead of two, and it retires the package name 0.5.0 advertised (see below).
- **Watched-source registry** — `addSource`, `listSources`, `getSource`, `pauseSource`,
  `resumeSource`, `deleteSource`, `recompileSource` (`add_source` / `list_sources` / `remove_source`
  in MCP). Registering the _name_ of an authority (`{kind:"entity", name:"Aetna", intent:"payer
policy bulletins"}`) resolves it to the pages that publish it and watches them. `remove_source` is
  exposed to agents for a specific reason: a workspace watches a bounded number of _active_ sources,
  sources auto-registered from a check's citations count against that bound, and only deletion frees
  it — pausing does not. Without it, an agent that registers per task fills the registry, after which
  new citations are dropped and checks that used to be warm quietly go back to researching.
- **`recompileSource(id)` / `recompile_source(id)`** — `POST /v1/sources/:id/recompile`, answering
  `202 {source_id, job_id, created}`. A `kind:"url"` source registered directly never enqueues plan
  discovery on its own, and a source whose acquisition plan has broken has no other way back, so
  without this the registry had a state a customer could reach and not leave.
- **Document push** — `sendEvent()` (`POST /v1/events`) for documents Kaval cannot fetch: Kaval
  diffs, marks the dependent facts stale, re-evaluates, and emits a delta.
- **`fact_state.delta` webhook subscriptions** — `subscribeFactStateDeltas()`, `createWebhook()`,
  `listWebhooks()`, `setWebhookEnabled()`, `deleteWebhook()`, `replayWebhookDelivery()`, plus a typed
  `FactStateDeltaEvent` for receivers. This is the outbound half of the mechanism: without it, the
  background loops keep fact state fresh but nothing tells you a fact flipped until your next check.
  Deliberately **not** an MCP tool — minting a standing outbound callback and storing its signing
  secret is deploy-time configuration for a human or service, not an in-loop choice for an agent that
  owns neither the endpoint nor the secret.
- `KavalRetiredError` in both SDKs.

### Changed

- Tool descriptions rewritten for agent tool-selection: `check` states all three verdicts, spells out
  that **REVIEW is never permission to act**, and says the warm path costs no model call and no
  fetch so calling it on every consequential action is cheap. (That sentence originally quoted a
  millisecond figure. Nothing in the server measures one — there is no histogram, no percentile and
  no persisted latency column — so the number was withdrawn from every surface in both repositories.
  What the server does count, per check, is work: supplier calls and origin requests, both zero on
  the warm path.) `verify` is explicitly marked DEPRECATED and names `check`.
- READMEs in both repos rewritten around `check` + watching + deltas, each with an old→new migration
  table.
- **Client request deadlines now fit the call they wrap.** The Node and Python clients defaulted to
  30s while the server's research budget is 100s and its handler deadline 150s, so the copy-paste
  quickstart aborted its own headline call on every cold check. Both now default to 150s. MCP cannot:
  `@modelcontextprotocol/sdk` cancels a tool call at 60s, so the MCP server uses a shorter client
  deadline and sends an explicit `max_wait_ms` that fits inside the transport envelope rather than
  silently inheriting the server default.
- **`max_wait_ms` documented as it actually behaves** — default 100000, max 100000, `0` disables
  research (which is what `mode: "fast"` sets). Every client README, type comment and tool schema
  had carried a three-second default and a fifteen-second ceiling from an engine generation that no
  longer exists, which handed a first-time caller the exact timeout the change was made to remove.
- CI gained a **Live API** job (nightly + `workflow_dispatch`) that runs the MCP and Python live
  suites against a real server, and `release.yml` now gates every publish on it — `mcp` needs `npm`,
  `mcp_registry` needs `mcp`, and `pypi` needs `npm` purely to inherit the gate. Both suites are
  `skipIf`-gated on their credentials, so the jobs fail rather than skip when a secret is unset —
  a hermetic-only pipeline is how the 30s deadline shipped. The Python job also runs on 3.10, the
  floor `pyproject.toml` promises.
- **The release gate resolves three ways, and refuses by default.** The staging secrets it needs are
  not set on the repository, so a gate that merely hard-fails on their absence would block every
  release forever, and one that skips is the failure it exists to prevent. With both secrets, the
  live suites run and a broken client fails there. Without them, a tag push fails and publishes
  nothing. Publishing anyway requires a human to run the workflow from the Actions tab and type
  `publish-unverified` into the `publish_without_live_gate` input — a tag push carries no inputs, so
  it can never take that path — and every package in such a run is labelled UNVERIFIED in the job
  summary. `scripts/check-release-workflow.mjs` pins all of it.
- All packages bumped 0.5.0 → 0.6.0 in lockstep.

### Retained

- **`verify()` / the `verify` tool** (`POST /v1/verify`) — unchanged wire contract, including its
  idempotency key and bounded ambiguous retry. Kept only while the pilot integrations migrate to
  `check`; it will be removed.
- `reportOutcome` / `report_outcome` (now keyed by `receipt.id`) and `health`.

### Fixed

- **Offline receipt verification is now installable, not just true.** 0.5.0 pointed readers at
  `@kaval/receipt-verifier`, a package that was never published to npm and returned 404 to anyone
  who tried it. The verifier is now folded into the Node SDK as `@usekaval/kaval/verify` (see
  **Added**), so the offline-verification claim these clients make is turnkey: `npm i
@usekaval/kaval` is the whole install.

## 0.5.0 — 2026-07-20

### Breaking

- **Commerce clients removed.** Product Research (`/v1/product-research`), Offer Search
  (`/v1/search-offers`), and the Offer Search gate (`/v1/search-offers/gate`) no longer exist
  server-side (the routes return 404). Every client surface for them is deleted: the Node
  `researchProducts` / `streamProductResearch` / `searchOffers` / `streamOfferSearch` /
  `gateOfferSearch` methods and their types, the Python `research_products` / `search_offers` /
  `gate_offer_search` methods, the MCP `product_research` / `offer_search` / `offer_search_gate`
  tools, and all commerce fixtures and tests.
- **`verify` is now the conclusion-verification surface** (`POST /v1/verify`): an assertable
  `conclusion` plus 1–20 `evidence_refs` (plain `https` URL strings or strict
  `{ url, document_id }` objects) in; `status` (`valid | invalidated | could_not_verify`) plus a
  signed `receipt` (`proof_id`, `decision: ALLOW | BLOCK | REVIEW`, `reason`, `share_endpoint`,
  full `packet`) out. The legacy belief-freshness verify remains available under a clearly-legacy
  name — never as `verify`.

### Added / aligned

- Verification surface aligned to the server wire contracts: `audit` builds the full signed
  ProofPacket (the expensive path); `gate` applies it at act time with no search, parsing, or
  model call, returning a typed state — `current`, `not_yet_valid`, `expired`, `invalidated`,
  `dependency_changed`, `integrity_failed`, `policy_mismatch`, or `operational_failure` — while an
  unknown proof surfaces as a typed `proof_not_found` error, not a 200.
- Ed25519-signed receipts documented end to end: `signature.algorithm: "Ed25519"`, public JWKs at
  `GET /v1/proof-verification-keys/:kid`, offline verification via the open `@kaval/receipt-verifier`.
  (**Corrected in 0.6.0:** that package name was never published to npm — `npm i` on it 404'd for
  the whole 0.5 line. The key endpoint and the published decision table were real; the verifier now
  ships as the `@usekaval/kaval/verify` subpath, and the old name is retired rather than published.)

### Changed

- MCP tool surface realigned to the verification protocol (`verify`, `proof_audit`, `proof_gate`,
  plus the legacy currentness tools and `report_outcome`).
- README repositioned around verify / audit / gate; commerce workflows removed from all docs.
- Non-commerce legacy surfaces (`check`, `extract-and-check`, `scan-store`, `monitor`, `kaval`,
  `kaval-batch`, `report-outcome`, `health`) unchanged and still tested.
- All packages bumped 0.4.0 → 0.5.0 in lockstep.
