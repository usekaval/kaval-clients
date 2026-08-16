/**
 * Wire types for the one pipeline: `POST /v1/check`, the watched-source registry, document push,
 * signed check receipts, and the `fact_state.delta` webhook subscriptions the background loops
 * deliver against. Field names match the hosted REST JSON exactly.
 */

import type {
  EntityRef,
  IsoTimestamp,
  Materiality,
  ScalarValue,
} from "./proof.js";

/** The verdict an agent branches on. Only ALLOW means "safe to act". */
export type CheckVerdict = "ALLOW" | "REVIEW" | "BLOCK";

/** The complete reason-code taxonomy — eight codes, no synonyms, no free text. */
export type CheckReasonCode =
  | "ALL_FACTS_HOLD"
  | "FACT_CHANGED"
  | "FACT_EXPIRED"
  | "FACT_UNKNOWN"
  | "SOURCE_UPDATED_PENDING_REVIEW"
  | "SOURCE_UNREACHABLE"
  | "NEW_FACT_UNVERIFIED"
  | "COMPILATION_UNCERTAIN";

/** The public three-valued projection of a fact's internal assessment. */
export type FactStatus = "holds" | "changed" | "unknown";

/** `fast` skips the live fallback entirely and answers from stored fact state only. */
export type CheckMode = "fast" | "standard";

/* ------------------------------ research budget ----------------------------- *
 * The `/v1/check` research budget, mirrored from the server's own constants so a caller — or the
 * MCP server that wraps this client — can bound `max_wait_ms` against the real numbers instead of
 * hand-typing them.
 *
 * They are two orders of magnitude larger than the three-second default this package used to
 * publish, which was a warm-path latency target applied to a cold path: a first check has to
 * search, fetch and adjudicate several novel facts, and a 3s budget returns every one of them as
 * `unknown` with no basis and no verdict worth reading. The consolation — that the detached
 * research warms state for next time — does not hold either, because the next check recompiles the
 * action and asks about different fingerprints.
 * ---------------------------------------------------------------------------- */

/** `0` disables research entirely. This is exactly what `mode: "fast"` sets. */
export const MIN_CHECK_MAX_WAIT_MS = 0;

/** What the server applies when `max_wait_ms` is omitted: let the research finish. */
export const DEFAULT_CHECK_MAX_WAIT_MS = 100_000;

/** Equal to the default on purpose — the budget exists to ask for LESS waiting, never more. */
export const MAX_CHECK_MAX_WAIT_MS = 100_000;

/**
 * A claim already decomposed by the caller. Structured claims are the zero-LLM path: they
 * canonicalize straight to a fact fingerprint, so the warm lookup needs no model call.
 */
export interface StructuredClaim {
  subject: string | EntityRef;
  predicate: string;
  object?: string | EntityRef | ScalarValue;
  /** What the claim is scoped to, e.g. `{ jurisdiction: "US", plan: "HMO" }`. */
  scope?: Record<string, ScalarValue>;
  materiality?: Materiality;
  /** Optional human rendering; defaults to a deterministic render of the structure. */
  text?: string;
}

export type ClaimInput = string | StructuredClaim;

/** `POST /v1/check` body. Provide at least one of `action` or `claims`. */
export interface CheckInput {
  /** What the agent is about to do, in plain language. Kaval compiles the facts it depends on. */
  action?: string;
  /** Anything the agent already knows that bears on the action. */
  context?: string;
  /** Facts to check directly, as plain sentences or structured claims (max 20). */
  claims?: ClaimInput[];
  mode?: CheckMode;
  /**
   * Live-path budget in ms (default 100000, max 100000; 0 disables research, which is what
   * `mode: "fast"` sets). Facts that miss it enter as `unknown`.
   */
  max_wait_ms?: number;
  /** Caller-declared origins, merged with the workspace's registered watched sources. */
  origin_urls?: string[];
  materiality?: Materiality;
  as_of?: IsoTimestamp;
}

export interface CheckSourceRef {
  locator: string;
  version_sha256?: string;
  fetched_at?: IsoTimestamp;
}

export interface CheckFact {
  fingerprint: string;
  text: string;
  status: FactStatus;
  materiality: Materiality;
  /** True when the answer came from warm fact state instead of live research. */
  served_from_state: boolean;
  last_verified_at: string | null;
  sources: CheckSourceRef[];
}

export interface CheckLatency {
  compile: number;
  lookup: number;
  live: number;
  total: number;
}

/** `POST /v1/check` response. `receipt.id` fetches the full signed document via `getReceipt()`. */
export interface CheckResult {
  decision: CheckVerdict;
  reason_codes: CheckReasonCode[];
  facts: CheckFact[];
  receipt: { id: string; signature: string; signed_at: IsoTimestamp };
  latency_ms: CheckLatency;
}

/* --------------------------------- receipts --------------------------------- */

/** Why a stored fact state could not be served; published so the verdict re-derives offline. */
export type CheckFreshnessFailure =
  | "stale"
  | "dormant"
  | "basis_superseded"
  | "source_unreachable"
  | "ttl_expired";

export interface CheckReceiptBasis {
  source_locator: string;
  /** Absent when nothing was pinned — never the source's read-time sha. */
  version_sha256?: string;
  /**
   * What `version_sha256` covers. A PDF's canonical text is extracted markdown, so the same
   * document has two unequal legitimate digests; unlabelled, a holder cannot know which artifact to
   * hash and the digest is decorative. Travels with `version_sha256` or not at all.
   */
  version_sha256_of?: "canonical_text" | "raw_bytes";
  /** The extractor that produced the canonical text, when one did. Absent for a plain HTTP body. */
  parser_name?: string;
  parser_version?: string;
  fetched_at?: IsoTimestamp;
  publication_time?: IsoTimestamp;
  span_ref?: unknown;
}

export interface CheckReceiptFact {
  fingerprint: string;
  text: string;
  materiality: Materiality;
  state: FactStatus;
  checked_at: IsoTimestamp;
  method: "state" | "live" | "timeout";
  temporal_state: string | null;
  stale_pending: boolean;
  novel: boolean;
  freshness_failure: CheckFreshnessFailure | null;
  basis: CheckReceiptBasis[];
}

/**
 * The receipt EXACTLY as signed. The decision table is published, so this fact list re-derives the
 * verdict offline — verify `signature` with the issuer's Ed25519 public key.
 */
export interface CheckReceipt {
  receipt_version: string;
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  decision: CheckVerdict;
  reason_codes: CheckReasonCode[];
  decision_rule_version: string;
  mode: CheckMode;
  checked_at: IsoTimestamp;
  compilation_uncertain: boolean;
  facts: CheckReceiptFact[];
  proof_packet_ids: string[];
  signature: {
    algorithm: string;
    key_id: string;
    signature: string;
    signed_at: IsoTimestamp;
  };
}

/* ---------------------------------- sources --------------------------------- */

/**
 * `entity` resolves a plain name ("Aetna") to the URLs that publish it and watches those;
 * `push` is a document the customer POSTs to `/v1/events`; `discovered` is auto-registered when a
 * check cites a URL nobody registered.
 */
export type WatchedSourceKind =
  "url" | "push" | "connection" | "entity" | "discovered";

export type WatchedSourceOrigin = "registered" | "discovered" | "resolved";

export interface WatchedSource {
  id: string;
  kind: WatchedSourceKind;
  locator: string;
  label: string | null;
  intent: string | null;
  origin: WatchedSourceOrigin;
  parent_source_id: string | null;
  scope_keys: string[];
  active: boolean;
  poll_interval_s: number | null;
  next_poll_at: string | null;
  last_success_at: string | null;
  content_sha256: string | null;
  /** The `ExtractionSchema` id bound with `updateSource()`, or null if this source runs unbound. */
  extraction_schema_id?: string | null;
  created_at: IsoTimestamp;
}

export interface AddSourceInput {
  kind: WatchedSourceKind;
  /** The URL, connection id, or push locator. For `kind: "entity"` use `name` instead. */
  locator?: string;
  /** `kind: "entity"` reads more naturally as a name — it is the same locator field. */
  name?: string;
  label?: string;
  /** What you want watched about it, e.g. "payer policy bulletins". Drives entity resolution. */
  intent?: string;
  /** Scope tags used to route document pushes to the facts they can affect. */
  scope_keys?: string[];
  poll_interval_s?: number;
}

/**
 * What the authority filter decided about one candidate an `entity` registration resolved to.
 *
 * `ambiguous` is the outcome a customer must actually act on: a real page of the real entity, but
 * governing a different product line with different rules. Watching it silently produces a
 * confident, well-sourced, WRONG answer with a signed receipt on it, so Kaval surfaces the
 * ambiguity rather than guessing either way.
 */
export interface AuthorityDecision {
  url: string;
  outcome: "accepted" | "discarded" | "ambiguous";
  reason: string;
}

/** How Kaval reaches one source. The plan document itself is deliberately not published. */
export interface WatchedSourcePlan {
  source_id: string;
  plan: {
    id: string;
    plan_version: number;
    /** `manual` (a reviewed catalog row), `deterministic`, `llm`, or `ratchet`. */
    origin: string;
    active: boolean;
    /** NULL means PROBATION: adopted or derived, and not yet proven against the live source. */
    last_validated_at: string | null;
    /** 0 declared feed · 1 backing document · 2 templated · 3 static crawl · 4 scripted browser. */
    tier: number;
    steps: Array<{ id: string; kind: string }>;
    emit_kind: string;
    /** Documents the last successful poll found in the library. Null until one has run. */
    items_in_scope: number | null;
  } | null;
  discovery: {
    status: string;
    reason: string;
    attempts: number;
    error: string | null;
    /** Model spend on working out how to reach this source. `"0"` is the common case. */
    cost_usd: string | null;
    completed_at: string | null;
  } | null;
}

/** One source whose content moved, and how many of your conclusions were resting on it. */
export interface SourceExposure {
  source_id: string;
  locator: string;
  label: string | null;
  kind: string;
  moved_at: string | null;
  /**
   * False when `moved_at` is inferred from the current version's fetch time rather than read off a
   * recorded diff — the source moved, but there was no previous text to date the change against.
   */
  moved_at_is_recorded_change: boolean;
  conclusions: number;
  /** Already re-adjudicated and flipped. */
  conclusions_changed: number;
  /** Not yet re-read. A check answers REVIEW for these today. */
  conclusions_pending: number;
}

export interface PortfolioExposure {
  sources: SourceExposure[];
  /** Distinct conclusions across every exposed source — not a sum of the page. */
  total_conclusions: number;
  total_sources: number;
  truncated: boolean;
}

export interface AddSourceResult {
  source: WatchedSource;
  created: boolean;
  /** Sources an `entity` registration resolved to and is now watching. */
  resolved: WatchedSource[];
  resolution_error?: string;
  /** The authority filter's working, discards included. Inspect `ambiguous` entries. */
  authority?: AuthorityDecision[];
  /** Set when plan discovery failed for the new source; the source itself is still registered. */
  discovery_error?: string;
}

/**
 * `POST /v1/sources/:id/recompile` — enqueued, not compiled inline: discovery can drive a browser
 * and a model, so it belongs to the worker's budget rather than a request's lifetime.
 */
export interface RecompileSourceResult {
  source_id: string;
  job_id: string;
  /** False when a job was already open for this source — the recompile folded into it. */
  created: boolean;
}

/* ----------------------------------- events --------------------------------- */

/** `POST /v1/events` — the customer-push half of the watch mechanism. */
export interface SourceEventInput {
  /** Address an already-registered source… */
  source_id?: string;
  /** …or address the document as `namespace` + `document_id` (created on first sight). */
  namespace?: string;
  document_id?: string;
  /** Extracted text. Raw PDF bytes are not accepted. */
  content?: string;
  content_url?: string;
  content_sha256?: string;
  observed_at?: IsoTimestamp;
  scope_keys?: string[];
}

export interface SourceEventResult {
  accepted: boolean;
  /** False for a same-content push: no version row, no staleness, no delta webhook. */
  changed: boolean;
  source_id: string;
  version_id: string | null;
  content_sha256: string;
  previous_content_sha256: string | null;
  /** Facts whose basis moved and whose re-evaluation is still running — checks REVIEW meanwhile. */
  facts_pending_review: number;
}

/* ---------------------------------- webhooks -------------------------------- */

export type WebhookSubscriptionKind =
  | "belief_integrity"
  | "monitor"
  | "fact_state"
  | "extraction"
  | "policy_update";

/** Kinds accepted on create. Existing `policy_update` subscriptions still appear on list. */
export type CreateWebhookSubscriptionKind = Exclude<
  WebhookSubscriptionKind,
  "policy_update"
>;

/** The only event a `fact_state` subscription accepts. */
export const FACT_STATE_DELTA_EVENT_TYPE = "fact_state.delta";

export interface CreateWebhookInput {
  subscription_kind: CreateWebhookSubscriptionKind;
  /** Must be https. */
  callback_url: string;
  event_types: string[];
  description?: string;
  /** Deliver only deltas whose scope intersects these ids. Empty means everything. */
  external_scope_ids?: string[];
  enabled?: boolean;
}

export interface WebhookSubscription {
  subscription_id: string;
  workspace_id?: string;
  subscription_kind?: WebhookSubscriptionKind;
  callback_url?: string;
  event_types?: string[];
  external_scope_ids?: string[];
  enabled?: boolean;
  signing_key_id?: string;
  [key: string]: unknown;
}

/** Everything needed to verify an inbound delta's HMAC signature. Returned once, at creation. */
export interface WebhookVerification {
  algorithm: string;
  key_id: string;
  secret: string;
  signed_content: string;
  headers: string[];
}

export interface CreateWebhookResult {
  subscription: WebhookSubscription;
  webhook_verification: WebhookVerification;
}

export type WebhookDeliveryState =
  | "pending"
  | "delivering"
  | "succeeded"
  | "retry_scheduled"
  | "dead_letter"
  | "cancelled";

/** One attempted delivery. `delivery_id` is the only place a replayable id is published. */
export interface WebhookDelivery {
  delivery_id: string;
  subscription_id: string;
  callback_event_id: string;
  signing_key_id: string;
  state: WebhookDeliveryState;
  attempt: number;
  response_status: number | null;
  error_code: string | null;
  next_attempt_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  delivered_at: IsoTimestamp | null;
  operation_id: string | null;
  is_test: boolean;
  [key: string]: unknown;
}

export interface WebhookDeliveryPage {
  items: WebhookDelivery[];
  /** Feed back as `before` for the next page. Null when this page is the last one. */
  next_before: IsoTimestamp | null;
  [key: string]: unknown;
}

/**
 * The result of rotating a subscription's signing key. `previous_key_expires_at` is the overlap
 * window: bodies signed by the old generation keep verifying until then, so you can redeploy.
 */
export interface WebhookKeyRotation {
  subscription_id: string;
  workspace_id?: string;
  signing_key_id: string;
  previous_signing_key_id: string | null;
  previous_key_expires_at: IsoTimestamp | null;
  [key: string]: unknown;
}

export interface RotateWebhookSigningKeyResult {
  rotation: WebhookKeyRotation;
  /** The new secret, shown exactly once — same contract as creation. */
  webhook_verification: WebhookVerification;
}

/* ------------------------------- delta payload ------------------------------ */

export interface FactBasisRef {
  source_locator: string;
  version_sha256?: string;
  fetched_at?: IsoTimestamp;
  publication_time?: IsoTimestamp;
  span_ref?: unknown;
}

export interface FactStateTransition {
  fingerprint: string;
  text: string;
  materiality: Materiality;
  old_state: FactStatus | null;
  new_state: FactStatus;
  basis: FactBasisRef[];
}

/**
 * The body of an inbound `fact_state.delta` webhook: "here is what changed and what it flipped."
 * Typed here so a receiver can parse it without reimplementing the contract.
 */
export interface FactStateDeltaEvent {
  specversion: "1.0";
  id: string;
  type: typeof FACT_STATE_DELTA_EVENT_TYPE;
  source: string;
  subject: string;
  time: IsoTimestamp;
  correlation_id: string;
  sequence: number;
  data: {
    tenant_id: string;
    workspace_id?: string | null;
    source: {
      watched_source_id: string;
      kind: WatchedSourceKind;
      locator: string;
      label?: string;
    };
    old_version_sha256: string | null;
    new_version_sha256: string;
    diff_summary: unknown;
    facts: FactStateTransition[];
    receipt?: {
      proof_packet_id?: string;
      receipt_url?: string;
      signature?: string;
    };
    changed_at: IsoTimestamp;
  };
}
