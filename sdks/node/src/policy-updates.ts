/**
 * Types for the policy-update pipeline: extraction schemas, per-payer extraction runs
 * ("policy updates"), the monthly package they roll up into, and the `policy_update.*` webhook
 * payloads delivered against a `policy_update` subscription.
 *
 * This is the Luminai loop: bind an `ExtractionSchema` to a watched source (or a whole payer),
 * let Kaval extract structured records from what it reads, and get `policy_update.document` /
 * `policy_update.monthly_package` webhooks as documents land — instead of polling
 * `listBulletins()` for the same information.
 */

/** A customer-defined JSON Schema Kaval extracts structured records against. */
export interface ExtractionSchema {
  id: string;
  workspace_id: string;
  name: string;
  json_schema: Record<string, unknown>;
  schema_sha256: string;
  created_at: string;
}

export interface CreateExtractionSchemaInput {
  name: string;
  json_schema: Record<string, unknown>;
}

export type ExtractionRunStatus =
  "processing" | "retry" | "succeeded" | "review_required" | "failed";

export type ExtractionRunScope = "document" | "payer_period";

/**
 * One extraction attempt — either against a single document (`scope: "document"`, the basis of a
 * `policy_update.document` webhook) or a payer + period rollup (`scope: "payer_period"`, created
 * by `createPolicyUpdate()`). This IS "a policy update": the API calls it `extraction_run` on the
 * wire because the same row backs both scopes.
 */
export interface ExtractionRun {
  id: string;
  workspace_id: string;
  scope: ExtractionRunScope;
  source_version_id?: string;
  /** Stable payer slug (e.g. `aetna`). Prefer `result.payer_name` for display. */
  payer_id?: string;
  /**
   * Publication / newsletter month `YYYY-MM`.
   * Not the effective month of an individual PA change — that stays on each record.
   */
  period?: string;
  extraction_schema_id: string | null;
  status: ExtractionRunStatus;
  model?: string;
  prompt_sha256?: string;
  sections?: Record<string, unknown>;
  /**
   * Schema records plus provenance helpers when present:
   * `records`, `record_evidence` (parallel to records), `document_period`, `period_basis`,
   * `payer_name`.
   */
  result?: Record<string, unknown>;
  raw_output?: string;
  error_code?: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

/** Request a payer + period extraction run. Requires `policy-update:manage`. */
export interface CreatePolicyUpdateInput {
  payer_id: string;
  /** Publication / newsletter month `YYYY-MM`. */
  period: string;
  extraction_schema_id: string;
}

export interface PolicyUpdateListOptions {
  payer_id?: string;
  period?: string;
  /** Inclusive YYYY-MM lower bound on `period`. Incompatible with exact `period`. */
  period_from?: string;
  /** Inclusive YYYY-MM upper bound on `period`. Incompatible with exact `period`. */
  period_to?: string;
  /** ISO-8601 — only runs with `created_at >=` this timestamp. */
  created_since?: string;
  /** ISO-8601 — only runs with `updated_at >=` this timestamp. */
  updated_since?: string;
  cursor?: string;
  limit?: number;
  /** When `"document"`, response includes parallel webhook-parity `documents`. */
  expand?: "document";
}

export interface PolicyUpdateListPage {
  extraction_runs: ExtractionRun[];
  /** Present when `expand: "document"` — same length/order as `extraction_runs`. */
  documents?: Array<PolicyUpdateDocumentEvent["data"] | null>;
  next_cursor: string | null;
}

export interface PolicyUpdateGetOptions {
  expand?: "document";
}

export interface PolicyUpdateGetResult {
  extraction_run: ExtractionRun;
  document?: PolicyUpdateDocumentEvent["data"] | null;
}

export type PolicyUpdatePackageStatus = "ready" | "partial";

/** The monthly rollup of every payer/period extraction into one PDF + manifest. */
export interface PolicyUpdatePackage {
  id: string;
  workspace_id: string;
  payer_id: string;
  /** Publication / newsletter month `YYYY-MM`. */
  period: string;
  status: PolicyUpdatePackageStatus;
  pdf_href: string;
  pdf_sha256?: string;
  manifest: Record<string, unknown>;
  built_at: string;
}

export interface PolicyUpdatePackageListOptions {
  payer_id?: string;
  period?: string;
}

/** `GET /v1/source-versions/:id/content` without `?format=sections`. */
export interface SourceVersionContent {
  content: string;
}

/** Normalized [0, 1] bounding box on a PDF page (from Parse layout at ingest). */
export interface PolicyUpdateBbox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One heading-bounded slice of a source version's canonical markdown. */
export interface PolicyUpdateDocumentSection {
  index: number;
  heading: string;
  start_offset: number;
  end_offset: number;
  text?: string;
  /** 1-indexed page when Parse layout was stored for this version. */
  page?: number;
  /** Normalized [0, 1] bbox on `page` when available. */
  bbox?: PolicyUpdateBbox;
}

/** Locates one extracted record in the source PDF via its section + layout. */
export interface PolicyUpdateRecordEvidence {
  section_index: number;
  page: number;
  bbox: PolicyUpdateBbox;
  block_ids?: string[];
}

/** `GET /v1/source-versions/:id/content?format=sections`. */
export interface SourceVersionSections {
  sections: PolicyUpdateDocumentSection[];
}

/** `PATCH /v1/sources/:id` — bind (or unbind, with `null`) the extraction schema a source runs. */
export interface UpdateSourceInput {
  id: string;
  extraction_schema_id: string | null;
}

/* ------------------------------ webhook payloads ----------------------------- */

export const POLICY_UPDATE_DOCUMENT_EVENT_TYPE = "policy_update.document";
export const POLICY_UPDATE_MONTHLY_PACKAGE_EVENT_TYPE =
  "policy_update.monthly_package";
export const POLICY_UPDATE_EVENT_TYPES = [
  POLICY_UPDATE_DOCUMENT_EVENT_TYPE,
  POLICY_UPDATE_MONTHLY_PACKAGE_EVENT_TYPE,
] as const;
export type PolicyUpdateEventType = (typeof POLICY_UPDATE_EVENT_TYPES)[number];

/** The body of an inbound `policy_update.document` webhook. */
export interface PolicyUpdateDocumentEvent {
  specversion: "1.0";
  id: string;
  type: typeof POLICY_UPDATE_DOCUMENT_EVENT_TYPE;
  source: string;
  subject: string;
  time: string;
  correlation_id: string;
  sequence: number;
  data: {
    workspace_id: string;
    payer_id: string;
    source_version_id: string;
    /** Durable Kaval source-version PDF URL — not a short-lived parser studio link. */
    pdf_href: string;
    content_href: string;
    sections: PolicyUpdateDocumentSection[];
    extraction_run: ExtractionRun;
    /** Present when a schema was bound; absent for content-only delivery. */
    extraction?: {
      records: unknown[];
      run_href: string;
      /** Parallel to `records`; empty array when a record has no locatable section. */
      record_evidence?: PolicyUpdateRecordEvidence[][];
    };
  };
}

/** The body of an inbound `policy_update.monthly_package` webhook. */
export interface PolicyUpdateMonthlyPackageEvent {
  specversion: "1.0";
  id: string;
  type: typeof POLICY_UPDATE_MONTHLY_PACKAGE_EVENT_TYPE;
  source: string;
  subject: string;
  time: string;
  correlation_id: string;
  sequence: number;
  data: {
    workspace_id: string;
    package: PolicyUpdatePackage;
  };
}

export type PolicyUpdateWebhookEvent =
  PolicyUpdateDocumentEvent | PolicyUpdateMonthlyPackageEvent;
