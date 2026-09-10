/**
 * @usekaval/kaval — before an AI agent acts, Kaval verifies the facts the action depends on and
 * returns ALLOW, REVIEW, or BLOCK with a signed receipt. A typed, dependency-light HTTP client for
 * the Kaval API. Mirrors the Python SDK (`pip install kaval`). Uses the global `fetch`
 * (Node 18+, browsers, edge).
 *
 * The primary loop for payer-policy monitoring: register a source with `addSource()`, bind an
 * `ExtractionSchema` to it (`createExtractionSchema()` + `updateSource()`), and subscribe to
 * `policy_update.*` webhooks with `subscribePolicyUpdates()` so structured records and monthly
 * packages are pushed to you as documents land. `check()` is the other half of the product: before
 * an agent acts, send the action and get ALLOW, REVIEW, or BLOCK with a signed receipt.
 */

import type {
  AddSourceInput,
  AddSourceResult,
  CheckInput,
  CheckReceipt,
  CheckResult,
  CreateWebhookInput,
  CreateWebhookResult,
  PortfolioExposure,
  RecompileSourceResult,
  RotateWebhookSigningKeyResult,
  SourceEventInput,
  SourceEventResult,
  WatchedSource,
  WatchedSourcePlan,
  WebhookDeliveryPage,
  WebhookSubscription,
} from "./check.js";
import { FACT_STATE_DELTA_EVENT_TYPE } from "./check.js";
import type {
  EvidenceRef,
  IsoTimestamp,
  VerifyRequest,
  VerifyResponse,
} from "./proof.js";
import type {
  CreateExtractionSchemaInput,
  CreatePolicyUpdateInput,
  ExtractionRun,
  ExtractionSchema,
  PolicyUpdateListOptions,
  PolicyUpdatePackage,
  PolicyUpdatePackageListOptions,
  SourceVersionContent,
  SourceVersionSections,
  UpdateSourceInput,
} from "./policy-updates.js";
import { POLICY_UPDATE_EVENT_TYPES } from "./policy-updates.js";
import type {
  BulletinExtractionAttemptDetailResponse,
  BulletinExtractionAttemptListOptions,
  BulletinExtractionAttemptPage,
  BulletinExtractionAttemptResource,
  BulletinListOptions,
  BulletinPage,
  BulletinRecord,
  ContractClaimPage,
  ContractClaimReviewInput,
  ContractClaimReviewResource,
  ContractCreateInput,
  ContractExtractionIssueListOptions,
  ContractExtractionIssuePage,
  ContractResource,
  ContractUploadInput,
  ContractUploadResource,
  FactImportInput,
  FactImportResource,
  TrainingFeedbackConsent,
  TrainingFeedbackConsentInput,
  TrainingFeedbackListOptions,
  TrainingFeedbackReviewList,
  TrainingJob,
  TrainingJobPage,
  TrainingJobStatus,
} from "./portfolio.js";
import {
  API_KEY_SCOPES,
  BULLETIN_EXTRACTION_ATTEMPT_STATUSES,
  CONTRACT_EXTRACTION_ISSUE_CODES,
  CONTRACT_EXTRACTION_REVIEW_STATES,
  MAX_CONTRACT_PDF_BYTES,
  MAX_FACT_IMPORT_ITEMS,
  MAX_FACT_IMPORT_SOURCE_REFERENCES,
  MAX_INLINE_CONTRACT_BYTES,
  MAX_PORTFOLIO_PAGE_SIZE,
} from "./portfolio.js";

export type * from "./proof.js";
export type * from "./check.js";
export type * from "./portfolio.js";
export type * from "./policy-updates.js";
export {
  DEFAULT_CHECK_MAX_WAIT_MS,
  FACT_STATE_DELTA_EVENT_TYPE,
  MAX_CHECK_MAX_WAIT_MS,
  MIN_CHECK_MAX_WAIT_MS,
} from "./check.js";
export {
  API_KEY_SCOPES,
  BULLETIN_EXTRACTION_ATTEMPT_STATUSES,
  CONTRACT_EXTRACTION_ISSUE_CODES,
  CONTRACT_EXTRACTION_REVIEW_STATES,
  MAX_CONTRACT_PDF_BYTES,
  MAX_FACT_IMPORT_ITEMS,
  MAX_FACT_IMPORT_SOURCE_REFERENCES,
  MAX_INLINE_CONTRACT_BYTES,
  MAX_PORTFOLIO_PAGE_SIZE,
} from "./portfolio.js";
export {
  POLICY_UPDATE_DOCUMENT_EVENT_TYPE,
  POLICY_UPDATE_EVENT_TYPES,
  POLICY_UPDATE_MONTHLY_PACKAGE_EVENT_TYPE,
} from "./policy-updates.js";

export type OutcomeKind =
  | "current_later_contradicted"
  | "stale_caught_real"
  | "stale_was_false_alarm"
  | "relied_and_correct";

/** Thrown on any non-2xx response. */
export class KavalError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    /** Reuse this key to resolve/replay a billable request after an ambiguous failure. */
    readonly idempotencyKey?: string,
  ) {
    super(`kaval ${status}: ${JSON.stringify(payload)}`);
    this.name = "KavalError";
  }
}

/**
 * Thrown when the API answers `410 tool_retired`. Every pre-0.6 verification endpoint
 * (`/v1/audit`, `/v1/gate`, `/v1/kaval`, `/v1/scan-store`, `/v1/extract-and-check`, `/v1/monitor`,
 * and the belief routes) collapsed into `POST /v1/check`. Call `check()` instead — the message says
 * so explicitly rather than leaving an agent to guess at an unexplained HTTP error.
 */
export class KavalRetiredError extends KavalError {
  readonly code = "tool_retired";
  /** The endpoint that replaced the one you called — always `/v1/check` today. */
  readonly replacement: string;

  constructor(payload: unknown, path: string, idempotencyKey?: string) {
    const replacement =
      (payload as { replacement?: unknown } | null)?.replacement ?? "/v1/check";
    super(410, payload, idempotencyKey);
    this.name = "KavalRetiredError";
    this.replacement =
      typeof replacement === "string" ? replacement : "/v1/check";
    this.message =
      `kaval 410: ${path} was retired in v0.6 — use ${this.replacement} ` +
      `(the \`check()\` method) instead. One call verifies the facts an action depends on and ` +
      `returns ALLOW, REVIEW, or BLOCK with a signed receipt.`;
  }
}

function attachIdempotencyKey(error: unknown, idempotencyKey: string): unknown {
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "idempotencyKey", {
        value: idempotencyKey,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // Preserve the original error even when a host object is non-extensible.
    }
  }
  return error;
}

export interface KavalOptions {
  apiKey?: string;
  /** Defaults to https://api.usekaval.com */
  baseUrl?: string;
  /** Inject a fetch implementation (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Default deadline for each HTTP operation. Defaults to 150 seconds; set null to disable. */
  timeoutMs?: number | null;
}

/** Transport options for one API operation. */
export interface RequestOptions {
  /** Mutations that require idempotency only. Kaval generates a UUID by default. Reuse the key
   * when you coordinate a retry after an ambiguous or no-response failure. */
  idempotencyKey?: string;
  /** Cancels the operation and every bounded retry. */
  signal?: AbortSignal;
  /** Per-call deadline override. Set null to disable the constructor default. */
  timeoutMs?: number | null;
}

const DEFAULT_BASE_URL = "https://api.usekaval.com";
/**
 * Matches the API's own handler deadline, which is `MAX_CHECK_MAX_WAIT_MS` plus headroom for
 * compile and receipt signing. 30s was shorter than the research budget the server applies by
 * default, so the client aborted the quickstart's very first cold `check()` — a client-side
 * deadline below the server's is a guaranteed failure, not a safety margin. Callers who want a
 * shorter wall clock should send `max_wait_ms` (or `mode: "fast"`), which returns a real verdict
 * instead of an `AbortError`.
 */
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_BILLABLE_ATTEMPTS = 2;
const AMBIGUOUS_IDEMPOTENCY_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_resolution_pending",
  "event_persistence_pending",
]);
let fallbackUuidSequence = 0;

function fallbackRandomUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node 18 exposes fetch but may not expose Web Crypto globally. Idempotency keys are uniqueness
    // tokens, not secrets, so mix multiple PRNG draws with time + a process-local sequence rather
    // than making every default billable call fail in that supported runtime.
    fallbackUuidSequence += 1;
    let state = (Date.now() ^ fallbackUuidSequence) >>> 0;
    for (let offset = 0; offset < bytes.length; offset += 1) {
      state =
        (Math.imul(
          state ^ Math.floor(Math.random() * 0x1_0000_0000),
          1_664_525,
        ) +
          1_013_904_223) >>>
        0;
      bytes[offset] = state & 0xff;
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generatedIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : fallbackRandomUuid();
}

function apiErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The retired-route body is a FLAT `{error:"tool_retired"}`, not the `{error:{code}}` envelope. */
function isRetiredPayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { error?: unknown }).error === "tool_retired"
  );
}

/** Fail fast on the wire-invalid evidence_refs shapes the server strictly rejects, before any
 *  network call or idempotency-key spend. */
function assertEvidenceRefs(refs: readonly EvidenceRef[]): void {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 20) {
    throw new TypeError(
      "evidence_refs must contain between 1 and 20 references",
    );
  }
  const documentIds = new Set<string>();
  for (const ref of refs) {
    if (typeof ref === "string") continue;
    const url = (ref as { url?: unknown })?.url;
    const documentId = (ref as { document_id?: unknown })?.document_id;
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof url !== "string" ||
      typeof documentId !== "string" ||
      documentId.length === 0
    ) {
      throw new TypeError(
        "each evidence reference must be a plain https URL string or a { url, document_id } object; a bare { url } object without document_id is invalid — pass the plain string instead",
      );
    }
    if (documentIds.has(documentId)) {
      throw new TypeError("evidence_refs document_id values must be unique");
    }
    documentIds.add(documentId);
  }
}

function requestSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | null,
): { signal: AbortSignal | undefined; cleanup(): void } {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number or null");
  }
  if (timeoutMs === null) return { signal: external, cleanup() {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`kaval request timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

function encodeId(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TypeError("an id is required");
  }
  return encodeURIComponent(id.trim());
}

function assertPortfolioPageLimit(limit: number | undefined): void {
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > MAX_PORTFOLIO_PAGE_SIZE)
  ) {
    throw new RangeError(
      `limit must be an integer from 1 through ${MAX_PORTFOLIO_PAGE_SIZE}`,
    );
  }
}

function assertContractUploadInput(input: ContractUploadInput): void {
  if (
    input.content_type !== "application/pdf" ||
    !Number.isInteger(input.size_bytes) ||
    input.size_bytes < 1 ||
    input.size_bytes > MAX_CONTRACT_PDF_BYTES ||
    !/^[0-9a-f]{64}$/u.test(input.sha256)
  ) {
    throw new TypeError("the contract upload metadata is invalid");
  }
}

function assertContractCreateInput(input: ContractCreateInput): void {
  if (
    input.effective_from !== null &&
    input.effective_to !== null &&
    input.effective_to < input.effective_from
  ) {
    throw new RangeError("effective_to must not be before effective_from");
  }
  if (
    input.source.kind === "canonical_text" &&
    new TextEncoder().encode(input.source.content).byteLength >
      MAX_INLINE_CONTRACT_BYTES
  ) {
    throw new RangeError(
      `canonical contract text must not exceed ${MAX_INLINE_CONTRACT_BYTES} UTF-8 bytes`,
    );
  }
}

function assertContractReviewInput(input: ContractClaimReviewInput): void {
  if (
    (input.decision === "correct") !==
    (input.corrected_claim !== undefined)
  ) {
    throw new TypeError(
      "corrected_claim is required only for a correct decision",
    );
  }
}

function assertFactImportInput(input: FactImportInput): void {
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > MAX_FACT_IMPORT_ITEMS
  ) {
    throw new RangeError(
      `fact imports must contain 1 through ${MAX_FACT_IMPORT_ITEMS} items`,
    );
  }
  const itemIds = new Set<string>();
  for (const item of input.items) {
    if (itemIds.has(item.item_id)) {
      throw new TypeError("fact import item_id values must be unique");
    }
    itemIds.add(item.item_id);
    if (item.source_ids.length > MAX_FACT_IMPORT_SOURCE_REFERENCES) {
      throw new RangeError(
        `source_ids must contain at most ${MAX_FACT_IMPORT_SOURCE_REFERENCES} entries`,
      );
    }
    if (new Set(item.source_ids).size !== item.source_ids.length) {
      throw new TypeError("fact import source_ids values must be unique");
    }
  }
}

function assertTrainingFeedbackConsentInput(
  input: TrainingFeedbackConsentInput,
): void {
  if (input.schema_version !== "training-feedback-consent-request/1.0.0") {
    throw new TypeError(
      "schema_version must be training-feedback-consent-request/1.0.0",
    );
  }
  if (
    (input.training_use !== "approved" && input.training_use !== "withheld") ||
    typeof input.consent_to_training !== "boolean"
  ) {
    throw new TypeError("training_use and consent_to_training are invalid");
  }
  if ((input.training_use === "approved") !== input.consent_to_training) {
    throw new TypeError("approved training use requires explicit consent");
  }
  if (
    input.reason !== undefined &&
    input.reason !== null &&
    (input.reason.trim().length < 1 || input.reason.trim().length > 1_000)
  ) {
    throw new RangeError("reason must contain 1 through 1000 characters");
  }
}

/**
 * The Kaval client.
 *
 * `check()` is the whole product: send the action an agent is about to take (or the claims it
 * rests on) and get ALLOW / REVIEW / BLOCK plus a signed receipt. Everything else configures what
 * Kaval watches so that check stays a warm database read instead of a research run.
 */
export class Kaval {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number | null;

  constructor(opts: KavalOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs =
      opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    if (
      this.timeoutMs !== null &&
      (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
    ) {
      throw new RangeError(
        "timeoutMs must be a positive finite number or null",
      );
    }
    this.headers = { "content-type": "application/json" };
    if (opts.apiKey) this.headers["authorization"] = `Bearer ${opts.apiKey}`;
  }

  private async billablePost<T>(
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const idempotencyKey = options.idempotencyKey ?? generatedIdempotencyKey();
    const headers = { ...this.headers, "idempotency-key": idempotencyKey };
    const request = requestSignal(
      options.signal,
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs,
    );

    try {
      for (let attempt = 0; attempt < MAX_BILLABLE_ATTEMPTS; attempt += 1) {
        let res: Response;
        try {
          res = await this.f(`${this.base}${path}`, {
            method: "POST",
            headers,
            signal: request.signal,
            // JSON.stringify omits `undefined` keys, so optional params drop out automatically.
            body: JSON.stringify(body),
          });
        } catch (error) {
          if (request.signal?.aborted) {
            throw attachIdempotencyKey(error, idempotencyKey);
          }
          // A fetch rejection is transport-ambiguous: the server may have committed before the
          // connection failed. Retry once with the SAME key so it replays instead of double-billing.
          if (attempt + 1 < MAX_BILLABLE_ATTEMPTS) continue;
          throw attachIdempotencyKey(error, idempotencyKey);
        }

        let payload: unknown;
        try {
          payload = await res.json();
        } catch (error) {
          // A 2xx without the promised JSON contract is a protocol failure, not a successful null
          // result. Error responses may legitimately come from a non-Kaval intermediary as text.
          if (res.ok) throw attachIdempotencyKey(error, idempotencyKey);
          payload = null;
        }
        if (res.ok) return payload as T;

        if (res.status === 410 && isRetiredPayload(payload)) {
          throw new KavalRetiredError(payload, path, idempotencyKey);
        }
        const code = apiErrorCode(payload);
        if (
          attempt + 1 < MAX_BILLABLE_ATTEMPTS &&
          code !== undefined &&
          AMBIGUOUS_IDEMPOTENCY_CODES.has(code)
        ) {
          continue;
        }
        throw new KavalError(res.status, payload, idempotencyKey);
      }
    } finally {
      request.cleanup();
    }

    throw new Error("unreachable billable request state");
  }

  /** One request, no idempotency key. Used by reads and by routes the server treats as reads. */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const operationKey = extraHeaders["idempotency-key"];
    const request = requestSignal(
      options.signal,
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs,
    );
    try {
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, {
          method,
          headers: { ...this.headers, ...extraHeaders },
          signal: request.signal,
          // JSON.stringify omits `undefined` keys, so optional params drop out automatically.
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw operationKey === undefined
          ? error
          : attachIdempotencyKey(error, operationKey);
      }
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 410 && isRetiredPayload(payload)) {
          throw new KavalRetiredError(payload, path);
        }
        throw new KavalError(res.status, payload, operationKey);
      }
      return payload as T;
    } finally {
      request.cleanup();
    }
  }

  /* ------------------------------- the one call ------------------------------ */

  /**
   * Verify the facts an action depends on, before acting on it.
   *
   * Send `action` (what the agent is about to do) and optionally `context`, or send `claims`
   * directly when you already know which facts matter. Kaval compiles the action into atomic
   * facts, answers each from watched-source state (warm: no model call, no fetch), falls back to
   * bounded live research for anything stale or novel, and returns:
   *
   *   - `decision` — **ALLOW** (every material fact still holds on a fresh basis), **REVIEW**
   *     (something is unknown, changed at low/medium materiality, or mid-re-evaluation), or
   *     **BLOCK** (a high/critical fact changed, or a critical fact is unknown).
   *   - `reason_codes` — why, from a closed eight-code taxonomy.
   *   - `facts` — one row per fact with its status and the sources it rests on.
   *   - `receipt` — the id + Ed25519 signature of a document that re-derives this verdict offline.
   *
   * Only ALLOW means "safe to act". REVIEW is never permission to act.
   */
  check(input: CheckInput, options?: RequestOptions): Promise<CheckResult> {
    if (input?.action === undefined && input?.claims === undefined) {
      throw new TypeError("check requires at least one of action or claims");
    }
    // A check is a read of current state, so the server deliberately does not replay it under an
    // idempotency key — a retry is free to recompute.
    return this.request("POST", "/v1/check", input, options);
  }

  /** Fetch a signed check receipt exactly as it was signed, by `result.receipt.id`. */
  async getReceipt(
    receiptId: string,
    options?: RequestOptions,
  ): Promise<CheckReceipt> {
    const { receipt } = await this.request<{ receipt: CheckReceipt }>(
      "GET",
      `/v1/receipts/${encodeId(receiptId)}`,
      undefined,
      options,
    );
    return receipt;
  }

  /* -------------------------- contract portfolio --------------------------- */

  /** Create a private PDF upload target. Upload the bytes before contract creation. */
  createContractUpload(
    input: ContractUploadInput,
    options?: RequestOptions,
  ): Promise<ContractUploadResource> {
    assertContractUploadInput(input);
    return this.request("POST", "/v1/contract-uploads", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
  }

  /** Queue one contract for extraction and review. */
  createContract(
    input: ContractCreateInput,
    options?: RequestOptions,
  ): Promise<ContractResource> {
    assertContractCreateInput(input);
    return this.request("POST", "/v1/contracts", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
  }

  getContract(
    contractId: string,
    options?: RequestOptions,
  ): Promise<ContractResource> {
    return this.request(
      "GET",
      `/v1/contracts/${encodeId(contractId)}`,
      undefined,
      options,
    );
  }

  listContractClaims(
    contractId: string,
    options?: RequestOptions & {
      status?: "proposed" | "approved" | "corrected" | "rejected";
      activationState?: "inactive" | "active" | "conflict" | "superseded";
      cursor?: string;
      limit?: number;
    },
  ): Promise<ContractClaimPage> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.status !== undefined) query.set("status", options.status);
    if (options?.activationState !== undefined)
      query.set("activation_state", options.activationState);
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/contracts/${encodeId(contractId)}/claims${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  /** List deterministic extraction failures that require customer review. */
  listContractExtractionIssues(
    contractId: string,
    options?: RequestOptions & ContractExtractionIssueListOptions,
  ): Promise<ContractExtractionIssuePage> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.issueCode !== undefined)
      query.set("issue_code", options.issueCode);
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/contracts/${encodeId(contractId)}/extraction-issues${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  reviewContractClaim(
    contractId: string,
    claimId: string,
    input: ContractClaimReviewInput,
    options?: RequestOptions,
  ): Promise<ContractClaimReviewResource> {
    assertContractReviewInput(input);
    return this.request(
      "POST",
      `/v1/contracts/${encodeId(contractId)}/claims/${encodeId(claimId)}/reviews`,
      input,
      options,
      {
        "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
      },
    );
  }

  /** Queue at most 400 facts. The server processes them in groups of 20. */
  createFactImport(
    input: FactImportInput,
    options?: RequestOptions,
  ): Promise<FactImportResource> {
    assertFactImportInput(input);
    return this.request("POST", "/v1/fact-imports", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
  }

  getFactImport(
    importId: string,
    options?: RequestOptions,
  ): Promise<FactImportResource> {
    return this.request(
      "GET",
      `/v1/fact-imports/${encodeId(importId)}`,
      undefined,
      options,
    );
  }

  /**
   * Soft-deprecated: bulletins are the free-text predecessor of the policy-update pipeline. Prefer
   * binding an `ExtractionSchema` to the source (`createExtractionSchema()` + `updateSource()`)
   * and reading `getPolicyUpdate()` / `policy_update.document` webhooks for structured records.
   * This method keeps working.
   */
  async getBulletin(
    bulletinId: string,
    options?: RequestOptions,
  ): Promise<BulletinRecord> {
    const { bulletin } = await this.request<{ bulletin: BulletinRecord }>(
      "GET",
      `/v1/bulletins/${encodeId(bulletinId)}`,
      undefined,
      options,
    );
    return bulletin;
  }

  /**
   * Soft-deprecated: prefer `listPolicyUpdates()` / `listPolicyUpdatePackages()` against a bound
   * `ExtractionSchema`, or subscribe to `policy_update.*` webhooks with `subscribePolicyUpdates()`.
   * This method keeps working.
   */
  listBulletins(
    options?: RequestOptions & BulletinListOptions,
  ): Promise<BulletinPage> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.sourceId !== undefined)
      query.set("source_id", options.sourceId);
    if (options?.payerId !== undefined) query.set("payer_id", options.payerId);
    if (options?.policyNumber !== undefined)
      query.set("policy_number", options.policyNumber);
    if (options?.code !== undefined) query.set("code", options.code);
    if (options?.recordStatus !== undefined)
      query.set("record_status", options.recordStatus);
    if (options?.publishedFrom !== undefined)
      query.set("published_from", options.publishedFrom);
    if (options?.publishedTo !== undefined)
      query.set("published_to", options.publishedTo);
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/bulletins${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  /**
   * List the customer-readable extraction lifecycle for structured bulletins.
   *
   * Soft-deprecated: this reports on the free-text bulletin pipeline. For schema-bound
   * extraction, `getPolicyUpdate()` / `listPolicyUpdates()` report the same lifecycle
   * (`processing` → `succeeded` / `review_required` / `failed`) against structured records.
   */
  listBulletinExtractionAttempts(
    options?: RequestOptions & BulletinExtractionAttemptListOptions,
  ): Promise<BulletinExtractionAttemptPage> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.sourceId !== undefined)
      query.set("source_id", options.sourceId);
    if (options?.status !== undefined) query.set("status", options.status);
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/bulletins/extraction-attempts${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  /** Get one bulletin extraction attempt by its source-version identifier. */
  async getBulletinExtractionAttempt(
    sourceVersionId: string,
    options?: RequestOptions,
  ): Promise<BulletinExtractionAttemptResource> {
    const response =
      await this.request<BulletinExtractionAttemptDetailResponse>(
        "GET",
        `/v1/bulletins/extraction-attempts/${encodeId(sourceVersionId)}`,
        undefined,
        options,
      );
    return response.data;
  }

  async getTrainingJob(
    jobId: string,
    options?: RequestOptions,
  ): Promise<TrainingJob> {
    const response = await this.request<TrainingJob | { job: TrainingJob }>(
      "GET",
      `/v1/training-jobs/${encodeId(jobId)}`,
      undefined,
      options,
    );
    return "job" in response ? response.job : response;
  }

  listTrainingJobs(
    options?: RequestOptions & {
      status?: TrainingJobStatus;
      demoOnly?: boolean;
      cursor?: string;
      limit?: number;
    },
  ): Promise<TrainingJobPage> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.status !== undefined) query.set("status", options.status);
    if (options?.demoOnly !== undefined)
      query.set("demo_only", String(options.demoOnly));
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request<
      | TrainingJobPage
      | { training_jobs: TrainingJob[]; next_cursor: string | null }
    >(
      "GET",
      `/v1/training-jobs${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    ).then((response) =>
      "training_jobs" in response
        ? { jobs: response.training_jobs, next_cursor: response.next_cursor }
        : response,
    );
  }

  /** List feedback that requires an explicit training-use decision. */
  listTrainingFeedback(
    options?: RequestOptions & TrainingFeedbackListOptions,
  ): Promise<TrainingFeedbackReviewList> {
    assertPortfolioPageLimit(options?.limit);
    const query = new URLSearchParams();
    if (options?.effectiveTrainingUse !== undefined)
      query.set("effective_training_use", options.effectiveTrainingUse);
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/training-feedback${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  /** Record the operator's explicit training-use decision for one feedback item. */
  recordTrainingFeedbackConsent(
    feedbackId: string,
    input: TrainingFeedbackConsentInput,
    options?: RequestOptions,
  ): Promise<TrainingFeedbackConsent> {
    assertTrainingFeedbackConsentInput(input);
    return this.request(
      "POST",
      `/v1/training-feedback/${encodeId(feedbackId)}/consent`,
      input,
      options,
      {
        "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
      },
    );
  }

  /* --------------------------------- sources --------------------------------- */

  /**
   * Register something for Kaval to watch. A URL is polled conditionally; an `entity` (a plain
   * name plus what you care about, e.g. `{kind:"entity", name:"Aetna", intent:"payer policy
   * bulletins"}`) is resolved to the URLs that publish it; a `push` source is a document you send
   * to `sendEvent()`. Facts learned from a watched source stay warm, so checks on them are a
   * database read.
   */
  addSource(
    input: AddSourceInput,
    options?: RequestOptions,
  ): Promise<AddSourceResult> {
    if (input?.locator === undefined && input?.name === undefined) {
      throw new TypeError(
        "addSource requires locator (or name for kind: 'entity')",
      );
    }
    return this.request("POST", "/v1/sources", input, options);
  }

  /** List the watched sources for this workspace, including any auto-discovered by a check. */
  async listSources(
    options?: RequestOptions & { includeInactive?: boolean },
  ): Promise<WatchedSource[]> {
    const query = options?.includeInactive ? "?include_inactive=true" : "";
    const { sources } = await this.request<{ sources: WatchedSource[] }>(
      "GET",
      `/v1/sources${query}`,
      undefined,
      options,
    );
    return sources;
  }

  async getSource(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<WatchedSource> {
    const { source } = await this.request<{ source: WatchedSource }>(
      "GET",
      `/v1/sources/${encodeId(sourceId)}`,
      undefined,
      options,
    );
    return source;
  }

  deleteSource(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<{ deleted: true; id: string }> {
    return this.request(
      "DELETE",
      `/v1/sources/${encodeId(sourceId)}`,
      undefined,
      options,
    );
  }

  /**
   * Re-derive a source's acquisition plan — how Kaval fetches and parses it. Enqueued rather than
   * compiled inline, so this answers `202` with a `job_id` while the worker does the work.
   *
   * This is the recovery path when a plan breaks (the site moved its content, or the parser stopped
   * matching), and the way to get a plan at all for a source registered directly as `kind: "url"`.
   * Pressing it bypasses the per-source cooldown, which is what a human pressing a button means.
   * `503 discovery_unavailable` means the deployment has no discovery worker configured.
   */
  recompileSource(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<RecompileSourceResult> {
    return this.request(
      "POST",
      `/v1/sources/${encodeId(sourceId)}/recompile`,
      {},
      options,
    );
  }

  /** Stop polling a source without forgetting it or the facts that depend on it. */
  /**
   * How Kaval reaches one source: the active acquisition plan's SHAPE, how much is in scope, and
   * the state of its last discovery job.
   *
   * The plan DOCUMENT is deliberately not published — it carries the user agent the plan was
   * validated with, the selectors it extracts by, and the interstitial markers it rejects on, which
   * together are a map of how to serve Kaval something it would accept. What you get is enough to
   * answer "is this watched properly, and what did working that out cost".
   */
  async getSourcePlan(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<WatchedSourcePlan> {
    return this.request<WatchedSourcePlan>(
      "GET",
      `/v1/sources/${encodeId(sourceId)}/plan`,
      undefined,
      options,
    );
  }

  /**
   * Every conclusion in this workspace resting on a source whose content has moved since the
   * conclusion was reached, grouped by source.
   *
   * The same predicate a check uses to refuse a warm answer, run across the whole portfolio: these
   * are exactly the facts that would come back REVIEW or BLOCK if you asked about them again.
   */
  async getExposure(
    options?: RequestOptions & { limit?: number },
  ): Promise<PortfolioExposure> {
    const query =
      options?.limit === undefined
        ? ""
        : `?limit=${encodeURIComponent(String(options.limit))}`;
    return this.request<PortfolioExposure>(
      "GET",
      `/v1/exposure${query}`,
      undefined,
      options,
    );
  }

  async pauseSource(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<WatchedSource> {
    const { source } = await this.request<{ source: WatchedSource }>(
      "POST",
      `/v1/sources/${encodeId(sourceId)}/pause`,
      {},
      options,
    );
    return source;
  }

  async resumeSource(
    sourceId: string,
    options?: RequestOptions,
  ): Promise<WatchedSource> {
    const { source } = await this.request<{ source: WatchedSource }>(
      "POST",
      `/v1/sources/${encodeId(sourceId)}/resume`,
      {},
      options,
    );
    return source;
  }

  /**
   * Bind (or, with `extraction_schema_id: null`, unbind) the extraction schema a source runs.
   * Every document that lands on this source afterward is extracted against the bound schema and
   * delivered as a `policy_update.document` webhook. Requires `policy-update:manage`.
   */
  async updateSource(
    input: UpdateSourceInput,
    options?: RequestOptions,
  ): Promise<WatchedSource> {
    const { source } = await this.request<{ source: WatchedSource }>(
      "PATCH",
      `/v1/sources/${encodeId(input.id)}`,
      { extraction_schema_id: input.extraction_schema_id },
      options,
    );
    return source;
  }

  /**
   * The canonical text Kaval extracted from one source version — the same text a
   * `policy_update.document` webhook and any bound extraction run were computed from. Pass
   * `format: "sections"` to get it pre-split into heading-bounded sections instead of one string.
   */
  getSourceVersionContent(
    sourceVersionId: string,
    options?: RequestOptions & { format?: "sections" },
  ): Promise<SourceVersionContent | SourceVersionSections> {
    const query = options?.format === "sections" ? "?format=sections" : "";
    return this.request(
      "GET",
      `/v1/source-versions/${encodeId(sourceVersionId)}/content${query}`,
      undefined,
      options,
    );
  }

  /* ---------------------------------- events --------------------------------- */

  /**
   * Push a document you own. Kaval stores the version, diffs it against the previous one, marks
   * the dependent facts stale, re-evaluates them in the background, and delivers a
   * `fact_state.delta` webhook naming what flipped. Address the document by `source_id`, or by
   * `namespace` + `document_id` (created on first sight).
   */
  sendEvent(
    input: SourceEventInput,
    options?: RequestOptions,
  ): Promise<SourceEventResult> {
    return this.request("POST", "/v1/events", input, options);
  }

  /* ------------------------------ policy updates ------------------------------ */

  /**
   * Register a JSON Schema Kaval extracts structured records against. Bind the returned schema's
   * `id` to a source with `updateSource()`, or pass it directly to `createPolicyUpdate()` for a
   * one-off payer + period run. Requires `policy-update:manage`.
   */
  async createExtractionSchema(
    input: CreateExtractionSchemaInput,
    options?: RequestOptions,
  ): Promise<ExtractionSchema> {
    const { extraction_schema } = await this.request<{
      extraction_schema: ExtractionSchema;
    }>("POST", "/v1/extraction-schemas", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
    return extraction_schema;
  }

  async getExtractionSchema(
    schemaId: string,
    options?: RequestOptions,
  ): Promise<ExtractionSchema> {
    const { extraction_schema } = await this.request<{
      extraction_schema: ExtractionSchema;
    }>(
      "GET",
      `/v1/extraction-schemas/${encodeId(schemaId)}`,
      undefined,
      options,
    );
    return extraction_schema;
  }

  async listExtractionSchemas(
    options?: RequestOptions,
  ): Promise<ExtractionSchema[]> {
    const { extraction_schemas } = await this.request<{
      extraction_schemas: ExtractionSchema[];
    }>("GET", "/v1/extraction-schemas", undefined, options);
    return extraction_schemas;
  }

  /**
   * Request a payer + period extraction run against a bound schema — the one-off counterpart to
   * letting a source's bound schema run automatically as documents land. Requires
   * `policy-update:manage`. Answers `202` with the run in `processing`; poll `getPolicyUpdate()`
   * or wait for its `policy_update.document` webhook.
   */
  async createPolicyUpdate(
    input: CreatePolicyUpdateInput,
    options?: RequestOptions,
  ): Promise<ExtractionRun> {
    const { extraction_run } = await this.request<{
      extraction_run: ExtractionRun;
    }>("POST", "/v1/policy-updates", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
    return extraction_run;
  }

  async getPolicyUpdate(
    runId: string,
    options?: RequestOptions,
  ): Promise<ExtractionRun> {
    const { extraction_run } = await this.request<{
      extraction_run: ExtractionRun;
    }>("GET", `/v1/policy-updates/${encodeId(runId)}`, undefined, options);
    return extraction_run;
  }

  listPolicyUpdates(
    options?: RequestOptions & PolicyUpdateListOptions,
  ): Promise<ExtractionRun[]> {
    const query = new URLSearchParams();
    if (options?.payer_id !== undefined)
      query.set("payer_id", options.payer_id);
    if (options?.period !== undefined) query.set("period", options.period);
    const search = query.toString();
    return this.request<{ extraction_runs: ExtractionRun[] }>(
      "GET",
      `/v1/policy-updates${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    ).then((response) => response.extraction_runs);
  }

  async getPolicyUpdatePackage(
    packageId: string,
    options?: RequestOptions,
  ): Promise<PolicyUpdatePackage> {
    const { package: pkg } = await this.request<{
      package: PolicyUpdatePackage;
    }>(
      "GET",
      `/v1/policy-update-packages/${encodeId(packageId)}`,
      undefined,
      options,
    );
    return pkg;
  }

  listPolicyUpdatePackages(
    options?: RequestOptions & PolicyUpdatePackageListOptions,
  ): Promise<PolicyUpdatePackage[]> {
    const query = new URLSearchParams();
    if (options?.payer_id !== undefined)
      query.set("payer_id", options.payer_id);
    if (options?.period !== undefined) query.set("period", options.period);
    const search = query.toString();
    return this.request<{ packages: PolicyUpdatePackage[] }>(
      "GET",
      `/v1/policy-update-packages${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    ).then((response) => response.packages);
  }

  /* --------------------------------- webhooks -------------------------------- */

  /**
   * Subscribe to `fact_state.delta` — the outbound half of the whole mechanism. Without a
   * subscription the background loops still keep fact state fresh, but nothing tells you a fact
   * flipped until your next `check()`. `external_scope_ids` filters deliveries to the scope keys
   * you care about. The returned `webhook_verification` is the only time the signing secret is
   * shown; store it and verify every inbound delivery with it.
   */
  subscribeFactStateDeltas(
    input: { callback_url: string } & Omit<
      CreateWebhookInput,
      "subscription_kind" | "event_types" | "callback_url"
    >,
    options?: RequestOptions,
  ): Promise<CreateWebhookResult> {
    return this.createWebhook(
      {
        ...input,
        subscription_kind: "fact_state",
        event_types: [FACT_STATE_DELTA_EVENT_TYPE],
      },
      options,
    );
  }

  /**
   * Subscribe to `policy_update.document` and `policy_update.monthly_package` — structured records
   * and monthly PDF rollups pushed as they land, instead of polling `listPolicyUpdates()` or
   * `listBulletins()` for the same information. `external_scope_ids` filters deliveries to the
   * payer/scope keys you care about. The returned `webhook_verification` is the only time the
   * signing secret is shown; store it and verify every inbound delivery with it.
   */
  subscribePolicyUpdates(
    input: { callback_url: string } & Omit<
      CreateWebhookInput,
      "subscription_kind" | "event_types" | "callback_url"
    >,
    options?: RequestOptions,
  ): Promise<CreateWebhookResult> {
    return this.createWebhook(
      {
        ...input,
        subscription_kind: "policy_update",
        event_types: [...POLICY_UPDATE_EVENT_TYPES],
      },
      options,
    );
  }

  /** Register any webhook subscription. `POST /v1/webhooks` requires an Idempotency-Key. */
  createWebhook(
    input: CreateWebhookInput,
    options?: RequestOptions,
  ): Promise<CreateWebhookResult> {
    if (!input?.callback_url?.startsWith("https://")) {
      throw new TypeError("callback_url must be an https URL");
    }
    return this.request("POST", "/v1/webhooks", input, options, {
      "idempotency-key": options?.idempotencyKey ?? generatedIdempotencyKey(),
    });
  }

  async listWebhooks(options?: RequestOptions): Promise<WebhookSubscription[]> {
    const { subscriptions } = await this.request<{
      subscriptions: WebhookSubscription[];
    }>("GET", "/v1/webhooks", undefined, options);
    return subscriptions;
  }

  /** Pause or resume deliveries without losing the subscription's signing key or history. */
  setWebhookEnabled(
    subscriptionId: string,
    enabled: boolean,
    options?: RequestOptions,
  ): Promise<WebhookSubscription> {
    return this.request(
      "PATCH",
      `/v1/webhooks/${encodeId(subscriptionId)}`,
      { enabled },
      options,
    );
  }

  deleteWebhook(
    subscriptionId: string,
    options?: RequestOptions,
  ): Promise<WebhookSubscription> {
    return this.request(
      "DELETE",
      `/v1/webhooks/${encodeId(subscriptionId)}`,
      undefined,
      options,
    );
  }

  /**
   * The delivery log for one subscription, newest first — what was sent, what the endpoint
   * answered, and what is dead-lettered. This is the only place a `delivery_id` is published, so it
   * is also how you find the argument for `replayWebhookDelivery()`.
   *
   * Page with `before` (an RFC 3339 timestamp; the response's `next_before` is the next cursor, and
   * null on the last page). `limit` is 1–200 and defaults to 50 server-side.
   */
  listWebhookDeliveries(
    subscriptionId: string,
    options?: RequestOptions & { before?: IsoTimestamp; limit?: number },
  ): Promise<WebhookDeliveryPage> {
    const query = new URLSearchParams();
    if (options?.before !== undefined) query.set("before", options.before);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.toString();
    return this.request(
      "GET",
      `/v1/webhooks/${encodeId(subscriptionId)}/deliveries${search === "" ? "" : `?${search}`}`,
      undefined,
      options,
    );
  }

  /**
   * Roll the subscription's signing key. `overlap_until` (RFC 3339, in the future and within 30
   * days) keeps the previous generation verifying until then, so a receiver can accept both while
   * it redeploys. The returned `webhook_verification.secret` is shown exactly once.
   */
  rotateWebhookSigningKey(
    subscriptionId: string,
    input: { overlap_until: IsoTimestamp },
    options?: RequestOptions,
  ): Promise<RotateWebhookSigningKeyResult> {
    if (!input?.overlap_until) {
      throw new TypeError(
        "rotateWebhookSigningKey requires overlap_until, the instant the previous signing key stops verifying",
      );
    }
    return this.request(
      "POST",
      `/v1/webhooks/${encodeId(subscriptionId)}/rotate`,
      input,
      options,
    );
  }

  /** Re-deliver one dead-lettered delivery after fixing the receiving endpoint. */
  replayWebhookDelivery(
    deliveryId: string,
    options?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/webhook-deliveries/${encodeId(deliveryId)}/replay`,
      {},
      options,
    );
  }

  /* --------------------------------- outcomes -------------------------------- */

  /** Report what actually happened for a prior check (by `result.receipt.id`), to calibrate. */
  reportOutcome(
    input: { id: string; kind: OutcomeKind; note?: string },
    options?: RequestOptions,
  ): Promise<{ ok: true }> {
    return this.request("POST", "/v1/report-outcome", input, options);
  }

  /* ------------------------------- pilot alias -------------------------------- */

  /**
   * @deprecated Pilot compatibility only — use {@link check}. Verifies one load-bearing conclusion
   * against explicit evidence references and returns a ProofPacket receipt. Kept while the Matey
   * pilot migrates; it will be removed once both pilots are on `check()`.
   */
  async verify(
    request: VerifyRequest,
    options?: RequestOptions,
  ): Promise<VerifyResponse> {
    assertEvidenceRefs(request.evidence_refs);
    return this.billablePost("/v1/verify", request, options);
  }

  /**
   * Liveness probe. Goes through the same transport as everything else so the documented
   * `{ signal, timeoutMs }` contract holds here too — a health check that could hang forever is the
   * one call where hanging is least acceptable.
   */
  health(
    options?: RequestOptions,
  ): Promise<{ ok: boolean; name: string; version: string }> {
    return this.request("GET", "/health", undefined, options);
  }
}

/** Convenience factory, for callers who prefer a function over `new`. */
export function createKaval(opts?: KavalOptions): Kaval {
  return new Kaval(opts);
}
