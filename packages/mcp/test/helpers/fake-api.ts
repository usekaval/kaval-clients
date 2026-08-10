import { readFileSync } from "node:fs";

/** A fake `/v1/*` fetch that always rejects with the given API error envelope, so MCP tests can
 *  exercise entitlement (402 subscription_required) / invalid-key (401) paths without the network or the engine. */
export function failingKavalFetch(
  status: number,
  code: string,
  message?: string,
): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ error: { code, ...(message ? { message } : {}) } }),
      { status, headers: { "content-type": "application/json" } },
    );
}

/** The structured 410 every retired MCP-era route answers, on every method. */
export const retiredKavalFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({ error: "tool_retired", replacement: "/v1/check" }),
    { status: 410, headers: { "content-type": "application/json" } },
  );

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

/** The exact POST /v1/verify PRIMARY response shape (conclusion + evidence_refs in, signed receipt
 *  out). NOTE: there is deliberately no receipt-level expires_at — expiry lives at
 *  receipt.packet.action_decision.expires_at. */
export const fakeVerifyReceipt = fixture<Record<string, any>>(
  "mcp-verify-receipt-v1.json",
);

/** A canonical primary-shape verify request (mixed plain-URL and { url, document_id } refs). */
export const fakeVerifyRequest = {
  conclusion:
    "The 2024 International Building Code is the current IBC edition.",
  evidence_refs: [
    "https://codes.iccsafe.org/content/IBC2024V2.0",
    {
      url: "https://www.iccsafe.org/products-and-services/i-codes/2024-i-codes/",
      document_id: "icc-2024-i-codes",
    },
  ],
  as_of: "2026-07-20T12:00:00.000Z",
  materiality: "high",
  intended_action: "Cite the current IBC edition in a permit filing",
  reversibility: "partially_reversible",
  jurisdiction: "US",
  context: "permit filing pre-check",
};

/** Ids the real API issues are uuids, and the routes that take them (`/v1/receipts/:id`,
 *  `/v1/sources/:id`) match on hex-and-dashes only — an opaque `rcpt_…` fixture certified a shape
 *  the server would have refused to route, and passes nothing the tool schemas now validate. */
export const fakeReceiptId = "4f1b5a2c-9d3e-4a71-8c62-0d5f1e7a3b90";
export const fakeSourceId = "8a2c6d14-3f57-4b09-9e81-6c0a2f5d7b31";

/** The exact POST /v1/check response shape: verdict, reason codes, per-fact status, receipt. */
export const fakeCheckResult = {
  decision: "BLOCK",
  reason_codes: ["FACT_CHANGED"],
  facts: [
    {
      fingerprint: "fact:sha256:1111111111111111",
      text: "Aetna requires prior authorization for CPT 12345",
      status: "changed",
      materiality: "critical",
      served_from_state: true,
      last_verified_at: "2026-07-25T09:00:00.000Z",
      sources: [
        {
          locator: "https://www.aetna.com/health-care-professionals/",
          version_sha256: "b".repeat(64),
          fetched_at: "2026-07-26T02:00:00.000Z",
        },
      ],
    },
  ],
  receipt: {
    id: fakeReceiptId,
    signature: "c2lnbmF0dXJl",
    signed_at: "2026-07-26T02:05:00.000Z",
  },
  latency_ms: { compile: 2, lookup: 9, live: 0, total: 14 },
};

/** The FULL signed document behind `fakeCheckResult.receipt.id` — what `GET /v1/receipts/:id`
 *  returns and `check` deliberately does not: per-fact basis, decision rule, signing key. */
export const fakeCheckReceipt = {
  receipt_version: "check-receipt/1.0.0",
  id: fakeReceiptId,
  tenant_id: "b3f0c9d2-1a44-4e77-9b25-7c8e0f1a6d33",
  workspace_id: null,
  decision: "BLOCK",
  reason_codes: ["FACT_CHANGED"],
  decision_rule_version: "check-decision/1.0.0",
  mode: "standard",
  checked_at: "2026-07-26T02:04:59.000Z",
  compilation_uncertain: false,
  facts: [
    {
      fingerprint: "fact:sha256:1111111111111111",
      text: "Aetna requires prior authorization for CPT 12345",
      materiality: "critical",
      state: "changed",
      checked_at: "2026-07-26T02:04:59.000Z",
      method: "state",
      temporal_state: null,
      stale_pending: false,
      novel: false,
      freshness_failure: null,
      basis: [
        {
          source_locator: "https://www.aetna.com/health-care-professionals/",
          version_sha256: "b".repeat(64),
          // The digest is decorative without saying what it covers — a PDF's canonical text and its
          // raw bytes are two unequal legitimate digests of one document.
          version_sha256_of: "canonical_text",
          parser_name: "html-canonical-text",
          parser_version: "1.0.0",
          fetched_at: "2026-07-26T02:00:00.000Z",
        },
      ],
    },
  ],
  proof_packet_ids: ["7c9d2e05-4b18-4d6a-9f33-2a1e8c0b5d47"],
  signature: {
    algorithm: "Ed25519",
    key_id: "kaval-proof-2026-07",
    signature: "c2lnbmF0dXJl",
    signed_at: "2026-07-26T02:05:00.000Z",
  },
};

export const fakeWatchedSource = {
  id: fakeSourceId,
  kind: "entity",
  locator: "Aetna",
  label: "Aetna",
  intent: "payer policy bulletins",
  origin: "registered",
  parent_source_id: null,
  scope_keys: [],
  active: true,
  poll_interval_s: 3_600,
  next_poll_at: "2026-07-26T03:00:00.000Z",
  last_success_at: "2026-07-26T02:00:00.000Z",
  content_sha256: "b".repeat(64),
  created_at: "2026-07-20T12:00:00.000Z",
};

export const fakeAddSourceResult = {
  source: fakeWatchedSource,
  created: true,
  resolved: [
    {
      ...fakeWatchedSource,
      id: "1d47b8e6-52c0-4a3f-8b91-e0f27c4a9d58",
      kind: "url",
      locator: "https://www.aetna.com/health-care-professionals/",
      origin: "resolved",
      parent_source_id: fakeWatchedSource.id,
    },
  ],
};

/** Canned `/v1/*` responses for MCP conformance without network or the private engine. */
export const fakeKavalFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const parsed = new URL(url);
  const path = parsed.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body
    ? (JSON.parse(init.body as string) as Record<string, unknown>)
    : {};

  // MCP inherits the Node HTTP client. Keep the fake hosted contract strict so conformance fails if
  // a billable tool ever stops sending the operation key required by issued-key traffic. A check is
  // a read of current state and deliberately carries none.
  if (
    path === "/v1/verify" &&
    !new Headers(init?.headers).get("idempotency-key")
  ) {
    return new Response(
      JSON.stringify({ error: { code: "idempotency_key_required" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  let data: unknown;
  switch (path) {
    case "/v1/check":
      data = fakeCheckResult;
      break;
    case "/v1/verify":
      data =
        "conclusion" in body ? fakeVerifyReceipt : { error: "bad_request" };
      break;
    case "/v1/sources":
      data =
        method === "POST"
          ? fakeAddSourceResult
          : {
              sources:
                parsed.searchParams.get("include_inactive") === "true"
                  ? [
                      fakeWatchedSource,
                      { ...fakeWatchedSource, id: "src_paused", active: false },
                    ]
                  : [fakeWatchedSource],
            };
      break;
    case "/v1/report-outcome":
      data = { ok: true };
      break;
    default:
      // The id-bearing reads/deletes. The path patterns mirror the server's own route regexes
      // (hex and dashes only), so a fixture id the real router would not match cannot pass here.
      if (path === `/v1/receipts/${fakeReceiptId}` && method === "GET") {
        data = { receipt: fakeCheckReceipt };
        break;
      }
      if (path === `/v1/sources/${fakeSourceId}` && method === "DELETE") {
        data = { deleted: true, id: fakeSourceId };
        break;
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export function parseToolText(res: unknown): {
  decision?: string;
  reason_codes?: string[];
  facts?: Array<{
    fingerprint?: string;
    text?: string;
    status?: string;
    materiality?: string;
    served_from_state?: boolean;
    sources?: Array<{ locator?: string }>;
  }>;
  latency_ms?: { total?: number };
  status?: string | number;
  id?: string;
  sources?: Array<Record<string, unknown>>;
  source?: Record<string, unknown>;
  created?: boolean;
  resolved?: Array<Record<string, unknown>>;
  receipt?: {
    id?: string;
    // A `check` receipt stub carries a bare signature string; the full document fetched by
    // `get_receipt` carries the signature object it was signed with.
    signature?: string | { algorithm?: string; key_id?: string };
    signed_at?: string;
    receipt_version?: string;
    decision_rule_version?: string;
    facts?: Array<{ basis?: Array<Record<string, unknown>> }>;
    proof_id?: string;
    decision?: string;
    reason?: string;
    share_endpoint?: string;
    packet?: {
      proof_id?: string;
      action_decision?: { decision?: string; expires_at?: string };
      signature?: { algorithm?: string; key_id?: string };
    };
  };
  deleted?: boolean;
  ok?: boolean;
  error?: string;
  message?: string;
  idempotency_key?: string;
} {
  const content = (res as { content: Array<{ type: string; text: string }> })
    .content;
  return JSON.parse(content[0]!.text);
}
