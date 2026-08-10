import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BULLETIN_EXTRACTION_ATTEMPT_STATUSES,
  CONTRACT_EXTRACTION_ISSUE_CODES,
  DEFAULT_CHECK_MAX_WAIT_MS,
  KavalError,
  KavalRetiredError,
  MAX_CONTRACT_PDF_BYTES,
  MAX_FACT_IMPORT_ITEMS,
  MAX_FACT_IMPORT_SOURCE_REFERENCES,
  MAX_INLINE_CONTRACT_BYTES,
  MAX_PORTFOLIO_PAGE_SIZE,
  MIN_CHECK_MAX_WAIT_MS,
  type Kaval,
} from "@usekaval/kaval";
import { z } from "zod";

/**
 * The live-research budget MCP asks for. Its floor and the API's own default come from the client,
 * which is where the published contract lives — quoting either by hand is how the "defaults to
 * 3000" this tool text used to carry outlived the engine that abandoned it.
 *
 * A cold action check genuinely uses DEFAULT_CHECK_MAX_WAIT_MS, but MCP cannot spend it:
 * `@modelcontextprotocol/sdk` cancels a tool call after DEFAULT_REQUEST_TIMEOUT_MSEC (60s), so a
 * check that silently inherited the server default would be killed by the caller mid-research and
 * the agent would see a cancelled request instead of a verdict. So this server sends a budget
 * explicitly, sized to fit inside the transport deadline in `env.ts` (55s) with room for the
 * round-trip: the timeout, when it comes, fires on our side with a recovery move attached.
 *
 * A caller can still ask for LESS — that is what the bound is for — down to MIN_CHECK_MAX_WAIT_MS,
 * which disables research entirely and is exactly what `mode: "fast"` sets.
 */
const MCP_CHECK_MAX_WAIT_MS = 45_000;

const RECOVERABLE_API_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_resolution_pending",
  "event_persistence_pending",
]);
const idempotencyKeyInput = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x20-\x7e]+$/)
  .optional()
  .describe(
    "reuse the operation key returned by an ambiguous prior attempt; omit for a new operation",
  );
const materialityInput = z.enum(["low", "medium", "high", "critical"]);
const reversibilityInput = z.enum([
  "reversible",
  "partially_reversible",
  "irreversible",
  "unknown",
]);
const httpUrlInput = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  }, "must be an http(s) URL");
// Mirrors the server's MateyEvidenceReference: a plain http(s) URL string, or a strict
// { url, document_id } pair. A bare object WITHOUT document_id is invalid on the wire — callers
// must send the plain string form instead.
const evidenceReferenceInput = z.union([
  httpUrlInput.describe("a plain http(s) evidence URL"),
  z
    .object({
      url: httpUrlInput,
      document_id: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .describe(
          "stable document identity, reusable for later change notifications",
        ),
    })
    .strict(),
]);
const evidenceRefsInput = z
  .array(evidenceReferenceInput)
  .min(1)
  .max(20)
  .superRefine((references, ctx) => {
    const documentIds = references.flatMap((reference) =>
      typeof reference === "string" ? [] : [reference.document_id],
    );
    if (new Set(documentIds).size !== documentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stable document_id values must be unique",
      });
    }
  })
  .describe(
    "1-20 evidence references the conclusion relies on: plain http(s) URL strings, or { url, document_id } objects with unique document_id values",
  );

/** A caller-decomposed fact. Structured claims skip compilation entirely — no model call. */
/** Mirrors the server's `EntityRef`: a named entity, optionally with an id and a type. */
const entityRefInput = z
  .object({
    name: z.string().trim().min(1).max(1_000),
    id: z.string().trim().min(1).max(1_000).optional(),
    type: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

/** Mirrors the server's `FactScope`: scalar values, not strings only. */
const scopeValueInput = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const structuredClaimInput = z
  .object({
    subject: z.union([z.string().trim().min(1).max(1_000), entityRefInput]),
    predicate: z.string().trim().min(1).max(1_000),
    object: z
      .union([
        z.string().trim().min(1).max(2_000),
        entityRefInput,
        z.number().finite(),
        z.boolean(),
        z.null(),
      ])
      .optional(),
    scope: z
      .record(z.string().trim().min(1).max(256), scopeValueInput)
      .optional()
      .describe(
        "what the claim is scoped to, e.g. { jurisdiction: 'US', plan: 'HMO' }",
      ),
    materiality: materialityInput.optional(),
    text: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const claimInput = z.union([
  z.string().trim().min(1).max(2_000).describe("the fact as a plain sentence"),
  structuredClaimInput,
]);

const watchedSourceKindInput = z.enum([
  "url",
  "push",
  "connection",
  "entity",
  "discovered",
]);

const uuidInput = z.string().uuid();
const stableIdInput = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._~:@/+-]*[A-Za-z0-9._~:@+-])?$/u,
    "must be a stable external identifier with no whitespace",
  );
const isoDateInput = z.string().date();
const sha256Input = z.string().regex(/^[0-9a-f]{64}$/u);
const httpsUrlInput = httpUrlInput.refine(
  (value) => value.length <= 2_048 && new URL(value).protocol === "https:",
  "must be an HTTPS URL",
);
const contractDocumentTypeInput = z.enum([
  "base_agreement",
  "amendment",
  "attachment",
  "fee_schedule",
  "other",
]);
const contractAuthorityInput = z.enum(["signed", "unsigned", "unknown"]);
const contractReviewStateInput = z.enum([
  "proposed",
  "approved",
  "corrected",
  "rejected",
]);
const contractActivationStateInput = z.enum([
  "inactive",
  "active",
  "conflict",
  "superseded",
]);
const contractExtractionIssueCodeInput = z.enum(
  CONTRACT_EXTRACTION_ISSUE_CODES,
);
const contractSourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), upload_id: uuidInput }).strict(),
  z
    .object({ kind: z.literal("content_url"), content_url: httpsUrlInput })
    .strict(),
  z
    .object({
      kind: z.literal("canonical_text"),
      content: z
        .string()
        .min(1)
        .refine(
          (value) =>
            new TextEncoder().encode(value).byteLength <=
            MAX_INLINE_CONTRACT_BYTES,
          `must not exceed ${MAX_INLINE_CONTRACT_BYTES} UTF-8 bytes`,
        ),
    })
    .strict(),
]);
const contractMetadataInput = {
  external_id: stableIdInput,
  title: z.string().trim().min(1).max(512),
  document_type: contractDocumentTypeInput,
  authority_status: contractAuthorityInput,
  contract_family_key: stableIdInput,
  effective_from: isoDateInput.nullable(),
  effective_to: isoDateInput.nullable(),
  supersedes_contract_id: uuidInput.nullable(),
} as const;
const factImportItemInput = z
  .object({
    item_id: stableIdInput,
    claim: structuredClaimInput,
    contract_claim_id: uuidInput.optional(),
    source_ids: z.array(uuidInput).max(MAX_FACT_IMPORT_SOURCE_REFERENCES),
  })
  .strict();
const bulletinStatusInput = z.enum(["candidate", "review", "confirmed"]);
const bulletinExtractionAttemptStatusInput = z.enum(
  BULLETIN_EXTRACTION_ATTEMPT_STATUSES,
);
const trainingStatusInput = z.enum([
  "queued",
  "running",
  "awaiting_promotion",
  "promoted",
  "rejected",
  "failed",
  "cancelled",
  "insufficient_data",
]);
const trainingUseInput = z.enum(["approved", "withheld"]);

const payerIdInput = z.string().trim().min(1).max(256);
/** `YYYY-MM`, the granularity every policy-update run and package is keyed by. */
const periodInput = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "must be a YYYY-MM period");
/** A JSON Schema document — validated structurally server-side; MCP only bounds its size. */
const jsonSchemaInput = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 65_536,
    "must not exceed 64 KiB serialized",
  );

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

async function resourceJson(
  uri: URL,
  read: () => Promise<unknown>,
): Promise<{
  contents: Array<{ uri: string; mimeType: "application/json"; text: string }>;
}> {
  let value: unknown;
  try {
    value = await read();
  } catch (error) {
    console.error("[kaval-mcp] resource error:", error);
    if (error instanceof KavalError) {
      const detail = apiError(error.payload);
      value = {
        error: detail.code ?? "request_failed",
        ...(detail.message ? { message: detail.message } : {}),
        status: error.status,
      };
    } else if (error instanceof TypeError) {
      value = {
        error: "network_unreachable",
        message: "could not reach the Kaval API",
      };
    } else {
      value = { error: "internal error" };
    }
  }
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

function templateId(
  value: string | string[] | undefined,
  name: string,
): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (id === undefined || !uuidInput.safeParse(id).success) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return id;
}

interface TransportOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function transportOptions(
  idempotencyKey: string | undefined,
  signal: AbortSignal,
): TransportOptions {
  return {
    signal,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/**
 * The exact wire operations this server drives on the injected `kaval` client, typed structurally
 * against the live `/v1/*` contract. The MCP zod schemas own request validation; the client owns
 * transport (auth headers, idempotency keys, bounded ambiguous-outcome retries).
 */
interface WireClient {
  check(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getReceipt(receiptId: string, options?: TransportOptions): Promise<unknown>;
  addSource(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  listSources(
    options?: TransportOptions & { includeInactive?: boolean },
  ): Promise<unknown>;
  deleteSource(sourceId: string, options?: TransportOptions): Promise<unknown>;
  reportOutcome(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  verify(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  createContractUpload(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  createContract(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getContract(contractId: string, options?: TransportOptions): Promise<unknown>;
  listContractClaims(
    contractId: string,
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  listContractExtractionIssues(
    contractId: string,
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  reviewContractClaim(
    contractId: string,
    claimId: string,
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  createFactImport(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getFactImport(importId: string, options?: TransportOptions): Promise<unknown>;
  listBulletins(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  getBulletin(bulletinId: string, options?: TransportOptions): Promise<unknown>;
  listBulletinExtractionAttempts(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  getBulletinExtractionAttempt(
    sourceVersionId: string,
    options?: TransportOptions,
  ): Promise<unknown>;
  listTrainingJobs(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  getTrainingJob(jobId: string, options?: TransportOptions): Promise<unknown>;
  listTrainingFeedback(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  recordTrainingFeedbackConsent(
    feedbackId: string,
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  createExtractionSchema(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  listExtractionSchemas(options?: TransportOptions): Promise<unknown>;
  createPolicyUpdate(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getPolicyUpdate(runId: string, options?: TransportOptions): Promise<unknown>;
  listPolicyUpdates(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  listPolicyUpdatePackages(
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
  updateSource(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getSourceVersionContent(
    sourceVersionId: string,
    options?: TransportOptions & Record<string, unknown>,
  ): Promise<unknown>;
}

/** Pull the API's `{ error: { code, message } }` envelope off a KavalError payload (defensively — the
 *  body may be a string, null, or some other shape if the API ever returns a non-standard error). */
function apiError(payload: unknown): { code?: string; message?: string } {
  if (payload && typeof payload === "object" && "error" in payload) {
    const err = (payload as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const { code, message } = err as { code?: unknown; message?: unknown };
      return {
        code: typeof code === "string" ? code : undefined,
        message: typeof message === "string" ? message : undefined,
      };
    }
    // The retired-route body is a FLAT { error: "tool_retired", replacement } — not the envelope.
    if (typeof err === "string") return { code: err };
  }
  return {};
}

/** True when a rejection means the request ran out of time — the MCP caller cancelled, or the
 *  client's own transport deadline fired. The node client aborts with the Error it constructed
 *  rather than a DOMException, so name-sniffing alone would miss its timeout. */
function isTimeout(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timed out/i.test(error.message)
  );
}

/** Run a tool body, returning a sanitized error result. An API error (e.g. 402 subscription_required
 *  / entitlement failure, 401 invalid key, 410 tool_retired) is surfaced with its status +
 *  code/message so the agent can act on it; a timeout and an unreachable host are named too,
 *  because both have a move the agent can make. Anything else collapses to a generic message so
 *  internal details never leak. */
async function safe(fn: () => Promise<unknown>, signal?: AbortSignal) {
  try {
    return json(await fn());
  } catch (e) {
    console.error("[kaval-mcp] tool error:", e);
    // A 410 means this client is older than the server's surface. Name the route that replaced the
    // one it called, read off the error — hard-coding a version number produced the absurdity of
    // telling a 0.6 caller to upgrade to 0.6, and would do it again at 0.7.
    if (e instanceof KavalRetiredError) {
      return toolError({
        error: "tool_retired",
        message: `this capability was folded into ${e.replacement} — call the \`check\` tool with the action you are about to take, or with the claims it depends on.`,
        status: 410,
      });
    }
    if (e instanceof KavalError) {
      const { code, message } = apiError(e.payload);
      return toolError({
        error: code ?? "request_failed",
        ...(message ? { message } : {}),
        status: e.status,
        ...(code && RECOVERABLE_API_CODES.has(code) && e.idempotencyKey
          ? { idempotency_key: e.idempotencyKey }
          : {}),
      });
    }
    const idempotencyKey =
      e && typeof e === "object" && "idempotencyKey" in e
        ? (e as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    if (typeof idempotencyKey === "string") {
      return toolError({
        error: "request_ambiguous",
        message: "retry later with the same idempotency_key",
        idempotency_key: idempotencyKey,
      });
    }
    // A check that outruns the deadline is the single most likely failure on the cold path, and an
    // agent handed the bare words "internal error" has nowhere to go. Both of the remaining shapes
    // have a next move, so say which one happened.
    if (isTimeout(e, signal)) {
      return toolError({
        error: "timeout",
        message:
          "the request did not finish inside the deadline — retry with mode:'fast' (stored state only, no research) or a smaller max_wait_ms",
      });
    }
    // `fetch` rejects with a TypeError when no response was ever produced: an unreachable host, a
    // DNS failure, or a malformed KAVAL_BASE_URL. That last one used to read as an internal fault.
    if (e instanceof TypeError) {
      return toolError({
        error: "network_unreachable",
        message:
          "could not reach the Kaval API — check KAVAL_BASE_URL and network access, then retry",
      });
    }
    return toolError({ error: "internal error" });
  }
}

/**
 * The agent-facing verification server.
 *
 * One tool does the work: `check`. Before an agent acts, it sends the proposed action; Kaval
 * identifies the facts that action depends on, checks them against the sources it watches, and
 * returns ALLOW, REVIEW, or BLOCK with a signed receipt. `get_receipt` fetches the full signed
 * document behind that receipt id, which is what an agent shows when it blocks. `add_source` /
 * `list_sources` / `remove_source` control what Kaval watches. Portfolio tools handle contracts,
 * bulk imports, structured bulletins, training status, feedback review, and explicit consent.
 * `report_outcome` closes the calibration loop. `verify` is a deprecated pilot alias.
 */
export function createMcpServer(client: Kaval): McpServer {
  const server = new McpServer({ name: "kaval", version: "0.7.5" });
  const api = client as unknown as WireClient;

  server.registerTool(
    "check",
    {
      description:
        "Verify the facts an action depends on BEFORE acting on it. Describe the action you are about to take (and any context you are relying on), or pass the specific claims, and Kaval re-checks each fact against the sources it watches — returning decision ALLOW, REVIEW, or BLOCK with a signed receipt. ALLOW: every material fact still holds on fresh evidence — proceed. REVIEW: something is unknown, mid-re-evaluation, or changed at low/medium materiality — REVIEW IS NEVER PERMISSION TO ACT; surface it to a human or re-research. BLOCK: a high/critical fact has changed, or a critical fact is unknown — do not proceed. Each returned fact carries its status (holds | changed | unknown) and the sources it rests on, so you can see exactly WHICH belief moved. A fact already backed by a watched source is answered from stored state with no model call and no fetch at all, so calling it on every consequential action is cheap; a fact Kaval has not seen before has to be researched first and takes seconds. Use this instead of re-researching a fact you already believe.",
      inputSchema: {
        action: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "what you are about to do, in plain language, e.g. 'Approve this claim at the 2026 in-network rate'. Kaval extracts the facts it depends on.",
          ),
        context: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "what you already believe that bears on the action — the retrieved chunk, the cached field, the prior answer",
          ),
        claims: z
          .array(claimInput)
          .min(1)
          .max(20)
          .optional()
          .describe(
            "check these facts directly instead of extracting them: plain sentences, or {subject, predicate, object, scope} objects (structured claims skip extraction entirely)",
          ),
        mode: z
          .enum(["fast", "standard"])
          .optional()
          .describe(
            "'standard' (default) may research anything stale or novel within max_wait_ms; 'fast' answers only from stored state and reports anything it does not know as unknown",
          ),
        max_wait_ms: z
          .number()
          .int()
          .min(MIN_CHECK_MAX_WAIT_MS)
          .max(MCP_CHECK_MAX_WAIT_MS)
          .optional()
          .describe(
            `budget in ms for live research on facts that are stale or new. Over MCP this defaults to ${MCP_CHECK_MAX_WAIT_MS} and cannot go higher, because a tool call is cancelled by the caller at 60s; the API's own default, for direct HTTP callers, is ${DEFAULT_CHECK_MAX_WAIT_MS}. Lower it when a bounded REVIEW beats waiting; ${MIN_CHECK_MAX_WAIT_MS} disables research entirely, which is what mode:'fast' does. Facts that miss the budget come back as unknown.`,
          ),
        origin_urls: z
          .array(httpUrlInput)
          .max(20)
          .optional()
          .describe(
            "authoritative sources for this action, merged with whatever this workspace already watches",
          ),
        materiality: materialityInput
          .optional()
          .describe(
            "how much this action's correctness matters — drives whether a changed fact is REVIEW or BLOCK",
          ),
        as_of: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("RFC 3339 cutoff for what the action may rely on"),
      },
    },
    async ({ max_wait_ms, ...args }, { signal }) => {
      if (args.action === undefined && args.claims === undefined) {
        return toolError({
          error: "bad_request",
          message:
            "provide `action` (what you are about to do) or `claims` (the facts to check)",
        });
      }
      // Always send the budget. Omitting it inherits the API's 100s default, which outlives the MCP
      // caller's own request deadline — the check would be cancelled rather than answered.
      return safe(
        () =>
          api.check(
            { ...args, max_wait_ms: max_wait_ms ?? MCP_CHECK_MAX_WAIT_MS },
            transportOptions(undefined, signal),
          ),
        signal,
      );
    },
  );

  server.registerTool(
    "get_receipt",
    {
      description:
        "Fetch the full signed receipt for a check you already ran, by the `receipt.id` that check returned. `check` gives you only the id, the signature, and when it was signed; this returns the document that was actually signed — every fact with its state and the evidence basis under it (source locator, content digest, fetch and publication time), the freshness failure if state could not be served, the decision-rule version, and the signing key id. Get it when you have to SHOW the work: attach it to a BLOCK you are escalating, hand it to a reviewer or auditor, or check the verdict offline — the decision table is published, so the receipt's own fact list re-derives its decision with no server involved.",
      inputSchema: {
        receipt_id: z
          .string()
          .uuid()
          .describe("the `receipt.id` from the check you want the proof for"),
      },
    },
    async ({ receipt_id }, { signal }) =>
      // The client unwraps the envelope for TypeScript callers; an agent reads a named field more
      // reliably than a bare object, so put it back.
      safe(
        async () => ({ receipt: await api.getReceipt(receipt_id, { signal }) }),
        signal,
      ),
  );

  server.registerTool(
    "prepare_contract_upload",
    {
      description:
        "Create a private PDF upload target. Upload the exact bytes to upload_url before you call ingest_contract with the returned upload id.",
      inputSchema: {
        filename: z.string().min(1).max(255),
        content_type: z.literal("application/pdf").default("application/pdf"),
        size_bytes: z.number().int().min(1).max(MAX_CONTRACT_PDF_BYTES),
        sha256: sha256Input.describe(
          "lowercase SHA-256 digest of the exact PDF bytes",
        ),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...input }, { signal }) =>
      safe(
        () =>
          api.createContractUpload(
            input,
            transportOptions(idempotency_key, signal),
          ),
        signal,
      ),
  );

  server.registerTool(
    "ingest_contract",
    {
      description:
        "Queue a contract for extraction. Use canonical text, an approved HTTPS content URL, or an upload id from prepare_contract_upload.",
      inputSchema: {
        ...contractMetadataInput,
        source: contractSourceInput,
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...input }, { signal }) => {
      if (
        input.effective_from !== null &&
        input.effective_to !== null &&
        input.effective_to < input.effective_from
      ) {
        return toolError({
          error: "bad_request",
          message: "effective_to must not be before effective_from",
        });
      }
      return safe(
        () =>
          api.createContract(input, transportOptions(idempotency_key, signal)),
        signal,
      );
    },
  );

  server.registerTool(
    "get_contract",
    {
      description:
        "Get contract processing status, candidate counts, and extraction issue state. Poll until the contract is ready for review or has failed.",
      inputSchema: { contract_id: uuidInput },
    },
    async ({ contract_id }, { signal }) =>
      safe(() => api.getContract(contract_id, { signal }), signal),
  );

  server.registerTool(
    "list_contract_claims",
    {
      description:
        "List extracted claim candidates with exact evidence spans. A reviewer must approve, correct, or reject each candidate before activation.",
      inputSchema: {
        contract_id: uuidInput,
        status: contractReviewStateInput.optional(),
        activation_state: contractActivationStateInput.optional(),
        cursor: z.string().min(1).max(1_000).optional(),
        limit: z.number().int().min(1).max(MAX_PORTFOLIO_PAGE_SIZE).optional(),
      },
    },
    async ({ contract_id, activation_state, ...options }, { signal }) =>
      safe(
        () =>
          api.listContractClaims(contract_id, {
            signal,
            ...options,
            ...(activation_state === undefined
              ? {}
              : { activationState: activation_state }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "list_contract_extraction_issues",
    {
      description:
        "List deterministic contract extraction failures for customer review. Each issue identifies the rejected candidate and evidence-line range without exposing contract text.",
      inputSchema: z
        .object({
          contract_id: uuidInput,
          issue_code: contractExtractionIssueCodeInput.optional(),
          cursor: z.string().min(1).max(1_000).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_PORTFOLIO_PAGE_SIZE)
            .optional(),
        })
        .strict(),
    },
    async ({ contract_id, issue_code, ...options }, { signal }) =>
      safe(
        () =>
          api.listContractExtractionIssues(contract_id, {
            signal,
            ...options,
            ...(issue_code === undefined ? {} : { issueCode: issue_code }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "review_contract_claim",
    {
      description:
        "Record an immutable human review. Use correct only with corrected_claim. The expected version prevents a stale review from overwriting newer work.",
      inputSchema: {
        contract_id: uuidInput,
        claim_id: uuidInput,
        review_id: stableIdInput,
        decision: z.enum(["approve", "correct", "reject"]),
        expected_candidate_version: z.number().int().positive(),
        reason: z.string().trim().min(1).max(4_000).optional(),
        corrected_claim: structuredClaimInput.optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async (
      { contract_id, claim_id, idempotency_key, ...input },
      { signal },
    ) => {
      if (
        (input.decision === "correct") !==
        (input.corrected_claim !== undefined)
      ) {
        return toolError({
          error: "bad_request",
          message: "corrected_claim is required only for a correct decision",
        });
      }
      return safe(
        () =>
          api.reviewContractClaim(
            contract_id,
            claim_id,
            input,
            transportOptions(idempotency_key, signal),
          ),
        signal,
      );
    },
  );

  server.registerTool(
    "import_facts",
    {
      description:
        "Queue 1 through 400 reviewed facts for warm checks. This tool does not create watched sources. Each item gets a terminal result.",
      inputSchema: {
        external_batch_id: stableIdInput,
        items: z.array(factImportItemInput).min(1).max(MAX_FACT_IMPORT_ITEMS),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, items, ...input }, { signal }) => {
      const itemIds = items.map((item) => item.item_id);
      if (new Set(itemIds).size !== itemIds.length) {
        return toolError({
          error: "duplicate_item_id",
          message: "item_id values must be unique",
        });
      }
      for (const item of items) {
        if (new Set(item.source_ids).size !== item.source_ids.length) {
          return toolError({
            error: "bad_request",
            message: `source_ids must be unique for item ${item.item_id}`,
          });
        }
      }
      return safe(
        () =>
          api.createFactImport(
            { ...input, items },
            transportOptions(idempotency_key, signal),
          ),
        signal,
      );
    },
  );

  server.registerTool(
    "get_fact_import",
    {
      description:
        "Get one bulk import and every item result. Poll until the batch reaches a terminal state.",
      inputSchema: { import_id: uuidInput },
    },
    async ({ import_id }, { signal }) =>
      safe(() => api.getFactImport(import_id, { signal }), signal),
  );

  server.registerTool(
    "list_bulletins",
    {
      description:
        "List structured payer bulletins. Filter by payer, policy, code, publisher date, or review status. Dates are publisher-stated dates only. Prefer create_extraction_schema + create_policy_update (or update_source's extraction_schema_id binding) for new integrations — this free-text pipeline still works but is not receiving new record types.",
      inputSchema: {
        source_id: uuidInput.optional(),
        payer_id: z.string().trim().min(1).max(256).optional(),
        policy_number: z.string().trim().min(1).max(256).optional(),
        code: z.string().trim().min(1).max(256).optional(),
        record_status: bulletinStatusInput.optional(),
        published_from: isoDateInput.optional(),
        published_to: isoDateInput.optional(),
        cursor: z.string().min(1).max(1_000).optional(),
        limit: z.number().int().min(1).max(MAX_PORTFOLIO_PAGE_SIZE).optional(),
      },
    },
    async (
      {
        source_id,
        payer_id,
        policy_number,
        record_status,
        published_from,
        published_to,
        ...options
      },
      { signal },
    ) => {
      if (
        published_from !== undefined &&
        published_to !== undefined &&
        published_from > published_to
      ) {
        return toolError({
          error: "invalid_bulletin_filter",
          message: "published_to must not be before published_from",
        });
      }
      return safe(
        () =>
          api.listBulletins({
            signal,
            ...options,
            ...(source_id === undefined ? {} : { sourceId: source_id }),
            ...(payer_id === undefined ? {} : { payerId: payer_id }),
            ...(policy_number === undefined
              ? {}
              : { policyNumber: policy_number }),
            ...(record_status === undefined
              ? {}
              : { recordStatus: record_status }),
            ...(published_from === undefined
              ? {}
              : { publishedFrom: published_from }),
            ...(published_to === undefined
              ? {}
              : { publishedTo: published_to }),
          }),
        signal,
      );
    },
  );

  server.registerTool(
    "get_bulletin",
    {
      description:
        "Get one structured bulletin by source-version id. Each field includes its status and exact evidence when available. Prefer get_policy_update for new integrations — this free-text pipeline still works but is not receiving new record types.",
      inputSchema: { source_version_id: uuidInput },
    },
    async ({ source_version_id }, { signal }) =>
      safe(() => api.getBulletin(source_version_id, { signal }), signal),
  );

  server.registerTool(
    "list_bulletin_extraction_attempts",
    {
      description:
        "List customer-readable bulletin extraction status. Filter by source or lifecycle state. This tool cannot requeue work. Prefer list_policy_updates for new integrations — this free-text pipeline still works but is not receiving new record types.",
      inputSchema: z
        .object({
          source_id: uuidInput.optional(),
          status: bulletinExtractionAttemptStatusInput.optional(),
          cursor: z.string().min(1).max(1_000).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_PORTFOLIO_PAGE_SIZE)
            .optional(),
        })
        .strict(),
    },
    async ({ source_id, ...options }, { signal }) =>
      safe(
        () =>
          api.listBulletinExtractionAttempts({
            signal,
            ...options,
            ...(source_id === undefined ? {} : { sourceId: source_id }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "get_bulletin_extraction_attempt",
    {
      description:
        "Get one customer-readable bulletin extraction attempt by source-version id. This tool cannot requeue work. Prefer get_policy_update for new integrations — this free-text pipeline still works but is not receiving new record types.",
      inputSchema: z.object({ source_version_id: uuidInput }).strict(),
    },
    async ({ source_version_id }, { signal }) =>
      safe(
        () => api.getBulletinExtractionAttempt(source_version_id, { signal }),
        signal,
      ),
  );

  server.registerTool(
    "list_training_jobs",
    {
      description:
        "List training and evaluation job status. This read-only tool does not start, approve, or promote a model.",
      inputSchema: {
        status: trainingStatusInput.optional(),
        demo_only: z.boolean().optional(),
        cursor: z.string().min(1).max(1_000).optional(),
        limit: z.number().int().min(1).max(MAX_PORTFOLIO_PAGE_SIZE).optional(),
      },
    },
    async ({ demo_only, ...options }, { signal }) =>
      safe(
        () =>
          api.listTrainingJobs({
            signal,
            ...options,
            ...(demo_only === undefined ? {} : { demoOnly: demo_only }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "get_training_job",
    {
      description:
        "Get one training job status. Production promotion remains an internal operation and is not available through MCP.",
      inputSchema: { job_id: uuidInput },
    },
    async ({ job_id }, { signal }) =>
      safe(() => api.getTrainingJob(job_id, { signal }), signal),
  );

  server.registerTool(
    "list_training_feedback",
    {
      description:
        "List reviewed feedback and its effective training-use state. This read requires training:manage and does not approve data for training.",
      inputSchema: z
        .object({
          effective_training_use: trainingUseInput.optional(),
          cursor: z.string().min(1).max(1_000).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_PORTFOLIO_PAGE_SIZE)
            .optional(),
        })
        .strict(),
    },
    async ({ effective_training_use, ...options }, { signal }) =>
      safe(
        () =>
          api.listTrainingFeedback({
            signal,
            ...options,
            ...(effective_training_use === undefined
              ? {}
              : { effectiveTrainingUse: effective_training_use }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "record_training_feedback_consent",
    {
      description:
        "Record an explicit, auditable training-use decision for one reviewed feedback item. This mutation requires training:manage. Approval requires consent_to_training=true.",
      inputSchema: z
        .object({
          feedback_id: uuidInput,
          training_use: trainingUseInput,
          consent_to_training: z.boolean(),
          reason: z.string().trim().min(1).max(1_000).nullable().optional(),
          idempotency_key: idempotencyKeyInput,
        })
        .strict(),
    },
    async (
      {
        feedback_id,
        training_use,
        consent_to_training,
        reason,
        idempotency_key,
      },
      { signal },
    ) => {
      if ((training_use === "approved") !== consent_to_training) {
        return toolError({
          error: "invalid_training_consent",
          message: "approved training use requires explicit consent",
        });
      }
      return safe(
        () =>
          api.recordTrainingFeedbackConsent(
            feedback_id,
            {
              schema_version: "training-feedback-consent-request/1.0.0",
              training_use,
              consent_to_training,
              ...(reason === undefined ? {} : { reason }),
            },
            transportOptions(idempotency_key, signal),
          ),
        signal,
      );
    },
  );

  server.registerTool(
    "create_extraction_schema",
    {
      description:
        "Register a JSON Schema Kaval extracts structured records against. Bind the returned schema's id to a source with update_source so every document that lands on it afterward is extracted automatically and delivered as a policy_update.document webhook, or pass it directly to create_policy_update for a one-off payer + period run. This is the schema-bound successor to list_bulletins' free-text extraction. Requires policy-update:manage.",
      inputSchema: {
        name: z.string().trim().min(1).max(512),
        json_schema: jsonSchemaInput.describe(
          "the JSON Schema records must satisfy, e.g. {type:'object', properties:{cpt_code:{type:'string'}}, required:['cpt_code']}",
        ),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...input }, { signal }) =>
      safe(
        () =>
          api.createExtractionSchema(
            input,
            transportOptions(idempotency_key, signal),
          ),
        signal,
      ),
  );

  server.registerTool(
    "list_extraction_schemas",
    {
      description:
        "List the extraction schemas registered in this workspace, newest first.",
      inputSchema: {},
    },
    async (_args, { signal }) =>
      safe(
        async () => ({
          extraction_schemas: await api.listExtractionSchemas({ signal }),
        }),
        signal,
      ),
  );

  server.registerTool(
    "create_policy_update",
    {
      description:
        "Request a one-off payer + period extraction run against a bound extraction schema, instead of waiting for the next document to land on a watched source. Requires policy-update:manage. Answers with the run in status 'processing' — poll get_policy_update or wait for its policy_update.document webhook.",
      inputSchema: {
        payer_id: payerIdInput.describe(
          "the payer this run extracts records for",
        ),
        period: periodInput.describe("the YYYY-MM period to extract"),
        extraction_schema_id: uuidInput,
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...input }, { signal }) =>
      safe(
        () =>
          api.createPolicyUpdate(
            input,
            transportOptions(idempotency_key, signal),
          ),
        signal,
      ),
  );

  server.registerTool(
    "get_policy_update",
    {
      description:
        "Get one extraction run ('policy update') by id — its status (processing | retry | succeeded | review_required | failed), the schema it ran against, and its extracted result once it succeeds. Pass expand='document' for the same PolicyUpdateDocumentData payload the policy_update.document webhook delivers (pdf_href, content_href, sections, optional extraction.records / record_evidence).",
      inputSchema: {
        run_id: uuidInput,
        expand: z.literal("document").optional(),
      },
    },
    async ({ run_id, expand }, { signal }) =>
      safe(
        () => api.getPolicyUpdate(run_id, { signal, ...(expand ? { expand } : {}) }),
        signal,
      ),
  );

  server.registerTool(
    "list_policy_updates",
    {
      description:
        "List extraction runs ('policy updates'). Filter by payer_id, exact period (YYYY-MM), period_from/period_to, created_since/updated_since (ISO-8601), and page with limit + cursor. Pass expand='document' for parallel webhook-parity documents[] (null for non-document runs). Returns { extraction_runs, next_cursor, documents? }. Prefer webhooks for steady state; use this to catch up. Sources live at list_sources / get_source_version_content.",
      inputSchema: {
        payer_id: payerIdInput.optional(),
        period: periodInput.optional(),
        period_from: periodInput.optional(),
        period_to: periodInput.optional(),
        created_since: z.string().datetime({ offset: true }).optional(),
        updated_since: z.string().datetime({ offset: true }).optional(),
        cursor: z.string().min(1).max(1_000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        expand: z.literal("document").optional(),
      },
    },
    async (args, { signal }) =>
      safe(async () => api.listPolicyUpdates({ signal, ...args }), signal),
  );

  server.registerTool(
    "list_policy_update_packages",
    {
      description:
        "List the monthly PDF + manifest rollups every payer/period's extraction runs are packaged into, optionally filtered by payer and/or YYYY-MM period. Each row's pdf_href is GET /v1/policy-update-packages/{id}/document — follow the 302 to a short-lived signed PDF (this tool does not download bytes).",
      inputSchema: {
        payer_id: payerIdInput.optional(),
        period: periodInput.optional(),
      },
    },
    async (args, { signal }) =>
      safe(
        async () => ({
          policy_update_packages: await api.listPolicyUpdatePackages({
            signal,
            ...args,
          }),
        }),
        signal,
      ),
  );

  server.registerTool(
    "add_source",
    {
      description:
        "Tell Kaval what to watch, so later checks are answered from fresh state instead of live research. Registering the NAME of an authority is usually enough: {kind:'entity', name:'Aetna', intent:'payer policy bulletins'} resolves to the pages that publish it and watches them. Use kind:'url' for a specific page, kind:'push' for a document your own system will send in. Kaval polls watched sources adaptively, re-evaluates the facts that depend on them when they change, and (if a fact_state webhook is configured) pushes you a delta naming what flipped. You do not have to call this first — an unregistered source cited by a check is auto-watched — but registering ahead of time is what makes the first check on a fact fast.",
      inputSchema: {
        kind: watchedSourceKindInput.describe(
          "url (a specific page) | entity (a name to resolve) | push (a document you will send to Kaval) | connection (a configured system of record)",
        ),
        locator: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .optional()
          .describe("the URL, connection id, or push locator"),
        name: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .optional()
          .describe(
            "for kind:'entity', the plain name of the authority, e.g. 'Aetna' — the same field as locator, spelled for readability",
          ),
        label: z.string().trim().min(1).max(512).optional(),
        intent: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe(
            "what you want watched about it, e.g. 'prior-authorization policy bulletins'. Drives entity resolution.",
          ),
        scope_keys: z
          .array(z.string().trim().min(1).max(256))
          .max(64)
          .optional()
          .describe(
            "tags that route document changes to the facts they can affect, e.g. ['plan:HMO','state:CA']",
          ),
        poll_interval_s: z
          .number()
          .int()
          .min(60)
          .max(7 * 24 * 60 * 60)
          .optional()
          .describe(
            "starting poll interval; Kaval adapts it — slower when nothing changes, faster when it does",
          ),
      },
    },
    async (args, { signal }) => {
      if (args.locator === undefined && args.name === undefined) {
        return toolError({
          error: "bad_request",
          message: "provide `locator`, or `name` for kind:'entity'",
        });
      }
      return safe(
        () => api.addSource(args, transportOptions(undefined, signal)),
        signal,
      );
    },
  );

  server.registerTool(
    "list_sources",
    {
      description:
        "List what Kaval currently watches for this workspace — including sources it auto-registered after a check cited them. Each row shows the locator, what it was registered for, when it was last successfully fetched, and whether it is active. Use it to see whether the fact you care about is actually backed by a watched source (and therefore fast and monitored) before relying on a check being warm.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .optional()
          .describe("also return paused sources (default false)"),
      },
    },
    async ({ include_inactive }, { signal }) =>
      // The client unwraps the envelope for TypeScript callers; an agent reads a named field more
      // reliably than a bare array, so put it back.
      safe(
        async () => ({
          sources: await api.listSources({
            signal,
            ...(include_inactive === undefined
              ? {}
              : { includeInactive: include_inactive }),
          }),
        }),
        signal,
      ),
  );

  server.registerTool(
    "remove_source",
    {
      description:
        "Stop watching a source and forget it, by the `id` `add_source` or `list_sources` returned. Removal is the only thing that frees a slot. Capacity is two ceilings: up to 200 active registered/resolved sources per workspace (every URL a check cites auto-registers against that ceiling), and up to 200 active discovered children per parent (those do not consume the workspace registered/resolved budget). Pausing does not free either. An agent that only ever adds eventually fills the workspace ceiling — after which new citations are silently dropped and checks that used to be warm go back to researching. Remove what you registered for a task once the task is done. This forgets the source itself, not the facts already checked against it.",
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe(
            "the watched-source id returned by add_source (`source.id`) or list_sources",
          ),
      },
    },
    async ({ id }, { signal }) =>
      safe(() => api.deleteSource(id, { signal }), signal),
  );

  server.registerTool(
    "update_source",
    {
      description:
        "Bind (or unbind) an extraction schema on a watched source, by the `id` add_source or list_sources returned. Once bound, every document that lands on the source is run through create_extraction_schema's schema automatically and delivered as a policy_update.document webhook — no more polling create_policy_update per period. Pass extraction_schema_id: null to unbind. Requires policy-update:manage.",
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe(
            "the watched-source id returned by add_source (`source.id`) or list_sources",
          ),
        extraction_schema_id: uuidInput
          .nullable()
          .describe(
            "the extraction schema to bind, or null to unbind and stop automatic extraction",
          ),
      },
    },
    async ({ id, ...input }, { signal }) =>
      safe(() => api.updateSource({ id, ...input }, { signal }), signal),
  );

  server.registerTool(
    "get_source_version_content",
    {
      description:
        "Fetch the captured content of one fetched version of a watched source, by the `source_version_id` a policy_update.document webhook or an extraction run names. Defaults to the raw canonical text; pass format:'sections' to get it pre-split into the same sections the sectionizer feeds extraction runs.",
      inputSchema: {
        source_version_id: uuidInput,
        format: z.enum(["sections"]).optional(),
      },
    },
    async ({ source_version_id, format }, { signal }) =>
      safe(
        () =>
          api.getSourceVersionContent(source_version_id, {
            signal,
            ...(format === undefined ? {} : { format }),
          }),
        signal,
      ),
  );

  server.registerTool(
    "report_outcome",
    {
      description:
        "Report what actually happened after a prior check, using the receipt id it returned, so Kaval can calibrate. Use `relied_and_correct` when you acted on an ALLOW and it held; `current_later_contradicted` when an ALLOW turned out to be wrong; `stale_caught_real` when a REVIEW/BLOCK caught a genuine change; `stale_was_false_alarm` when it did not.",
      // These bounds mirror the server's OutcomeRequest exactly. A model that invents a receipt id
      // is a real failure mode here, and it should hear the field name from us rather than get a
      // round-trip `bad_request` with nothing pointing at `id`.
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe("the `receipt.id` returned by the check you are labelling"),
        kind: z.enum([
          "current_later_contradicted",
          "stale_caught_real",
          "stale_was_false_alarm",
          "relied_and_correct",
        ]),
        note: z
          .string()
          .max(2_048)
          .refine(
            (value) => !value.includes("\0"),
            "must not contain null bytes",
          )
          .optional(),
      },
    },
    async (args, { signal }) =>
      safe(
        () => api.reportOutcome(args, transportOptions(undefined, signal)),
        signal,
      ),
  );

  // Deprecated pilot alias. Kept only while conclusion+evidence_refs integrations migrate; the
  // description steers new callers to `check` without breaking prompts that already name it.
  server.registerTool(
    "verify",
    {
      description:
        "DEPRECATED — prefer the `check` tool. Verifies one load-bearing conclusion against evidence references you supply and returns a signed ProofPacket receipt (status valid | invalidated | could_not_verify, receipt.decision ALLOW | REVIEW | BLOCK). Kept only for existing pilot integrations that pass explicit evidence_refs; it will be removed. New calls should use `check`, which needs no evidence list, is answered from watched state with no model call and no fetch, and keeps monitoring the facts afterwards.",
      inputSchema: {
        conclusion: z
          .string()
          .min(1)
          .max(10_000)
          .describe(
            "the exact assertable proposition the downstream workflow intends to rely on — a STATEMENT of what you believe, in the indicative. The API rejects anything phrased as a request or a question, INCLUDING the phrasing this tool's name invites: 'verify whether/if/that …', 'check whether …', 'is X still true?', and role prefixes like 'system:'. Write \"The 2024 International Building Code is the current IBC edition.\", not \"Verify that the 2024 IBC is the current edition.\"",
          ),
        evidence_refs: evidenceRefsInput,
        as_of: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("RFC 3339 cutoff for what the conclusion may rely on"),
        materiality: materialityInput.optional(),
        intended_action: z.string().trim().min(1).max(10_000).optional(),
        reversibility: reversibilityInput.optional(),
        jurisdiction: z.string().trim().min(1).max(256).optional(),
        context: z.string().trim().min(1).max(4_000).optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(
        () => api.verify(args, transportOptions(idempotency_key, signal)),
        signal,
      ),
  );

  server.registerResource(
    "contract",
    new ResourceTemplate("kaval://contracts/{contract_id}", {
      list: undefined,
    }),
    {
      title: "Contract status",
      description: "One contract and its current extraction status.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.getContract(templateId(variables.contract_id, "contract_id"), {
          signal,
        }),
      ),
  );

  server.registerResource(
    "contract-claims",
    new ResourceTemplate("kaval://contracts/{contract_id}/claims", {
      list: undefined,
    }),
    {
      title: "Contract claim candidates",
      description:
        "The first page of extracted claim candidates for one contract.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.listContractClaims(
          templateId(variables.contract_id, "contract_id"),
          { signal, limit: MAX_PORTFOLIO_PAGE_SIZE },
        ),
      ),
  );

  server.registerResource(
    "contract-extraction-issues",
    new ResourceTemplate("kaval://contracts/{contract_id}/extraction-issues", {
      list: undefined,
    }),
    {
      title: "Contract extraction issues",
      description:
        "The first page of deterministic extraction failures for one contract.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.listContractExtractionIssues(
          templateId(variables.contract_id, "contract_id"),
          { signal, limit: MAX_PORTFOLIO_PAGE_SIZE },
        ),
      ),
  );

  server.registerResource(
    "structured-bulletins",
    "kaval://bulletins",
    {
      title: "Structured bulletins",
      description: "The newest structured payer bulletins in this workspace.",
      mimeType: "application/json",
    },
    async (uri, { signal }) =>
      resourceJson(uri, () => api.listBulletins({ signal, limit: 50 })),
  );

  server.registerResource(
    "bulletin-extraction-attempts",
    "kaval://bulletins/extraction-attempts",
    {
      title: "Bulletin extraction attempts",
      description:
        "The newest customer-readable bulletin extraction lifecycle records.",
      mimeType: "application/json",
    },
    async (uri, { signal }) =>
      resourceJson(uri, () =>
        api.listBulletinExtractionAttempts({ signal, limit: 50 }),
      ),
  );

  server.registerResource(
    "structured-bulletin",
    new ResourceTemplate("kaval://bulletins/{source_version_id}", {
      list: undefined,
    }),
    {
      title: "Structured bulletin",
      description: "One structured payer bulletin with field evidence.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.getBulletin(
          templateId(variables.source_version_id, "source_version_id"),
          { signal },
        ),
      ),
  );

  server.registerResource(
    "bulletin-extraction-attempt",
    new ResourceTemplate(
      "kaval://bulletins/extraction-attempts/{source_version_id}",
      { list: undefined },
    ),
    {
      title: "Bulletin extraction attempt",
      description:
        "One customer-readable bulletin extraction lifecycle record.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.getBulletinExtractionAttempt(
          templateId(variables.source_version_id, "source_version_id"),
          { signal },
        ),
      ),
  );

  server.registerResource(
    "fact-import",
    new ResourceTemplate("kaval://fact-imports/{import_id}", {
      list: undefined,
    }),
    {
      title: "Bulk fact import",
      description: "One bulk fact import and its item results.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.getFactImport(templateId(variables.import_id, "import_id"), {
          signal,
        }),
      ),
  );

  server.registerResource(
    "training-jobs",
    "kaval://training-jobs",
    {
      title: "Training jobs",
      description: "The newest read-only training and evaluation job statuses.",
      mimeType: "application/json",
    },
    async (uri, { signal }) =>
      resourceJson(uri, () => api.listTrainingJobs({ signal, limit: 50 })),
  );

  server.registerResource(
    "training-feedback",
    "kaval://training-feedback",
    {
      title: "Training feedback",
      description:
        "Reviewed feedback and each item's explicit training-use state.",
      mimeType: "application/json",
    },
    async (uri, { signal }) =>
      resourceJson(uri, () => api.listTrainingFeedback({ signal, limit: 50 })),
  );

  server.registerResource(
    "training-job",
    new ResourceTemplate("kaval://training-jobs/{job_id}", {
      list: undefined,
    }),
    {
      title: "Training job",
      description: "One read-only training and evaluation job status.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) =>
      resourceJson(uri, () =>
        api.getTrainingJob(templateId(variables.job_id, "job_id"), {
          signal,
        }),
      ),
  );

  return server;
}
