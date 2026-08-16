/**
 * Types for the extraction pipeline: extraction schemas, per-publisher extraction runs
 * (the product still calls these Updates), the package they roll up into, and the
 * `extraction.*` webhook payloads delivered against an `extraction` subscription.
 *
 * This is the Luminai loop: bind an `ExtractionSchema` to a watched source (or a whole publisher),
 * let Kaval extract structured records from what it reads, and get `extraction.document` /
 * `extraction.package` webhooks as documents land — instead of polling
 * `listBulletins()` for the same information.
 */

import type { WatchedSource } from "./check.js";

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
 * One extraction attempt — either against a single document (`scope: "document"`, the basis of an
 * `extraction.document` webhook) or a publisher + period rollup (`scope: "payer_period"`, created
 * by `createExtractionRun()`). The product still calls this an Update.
 */
export interface ExtractionRun {
  id: string;
  workspace_id: string;
  scope: ExtractionRunScope;
  source_version_id?: string;
  /** Stable publisher slug (e.g. `aetna`). Prefer `result.payer_name` for display. */
  publisher_id?: string;
  /** Still accepted on the wire for one release if a host has not flipped the field. */
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
  reprocess?: true;
  generation?: number;
}

/** Request a publisher + period extraction run. Requires `policy-update:manage`. */
export interface CreateExtractionRunInput {
  publisher_id: string;
  /** Publication / newsletter month `YYYY-MM`. */
  period: string;
  extraction_schema_id: string;
}

export interface ExtractionRunListOptions {
  publisher_id?: string;
  /** Inclusive YYYY-MM lower bound on run `period`. Optional alone or with `period_to`. */
  period_from?: string;
  /** Inclusive YYYY-MM upper bound on run `period`. Optional alone or with `period_from`. */
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

export interface ExtractionRunListPage {
  extraction_runs: ExtractionRun[];
  /** Present when `expand: "document"` — same length/order as `extraction_runs`. */
  documents?: Array<ExtractionDocumentEvent["data"] | null>;
  next_cursor: string | null;
}

export interface ExtractionRunGetOptions {
  expand?: "document";
}

export interface ExtractionRunGetResult {
  extraction_run: ExtractionRun;
  document?: ExtractionDocumentEvent["data"] | null;
}

export type ExtractionPackageStatus = "ready" | "partial";

/** The monthly rollup of every publisher/period extraction into one PDF + manifest. */
export interface ExtractionPackage {
  id: string;
  workspace_id: string;
  publisher_id: string;
  /** Still accepted on the wire for one release if a host has not flipped the field. */
  payer_id?: string;
  /** Publication / newsletter month `YYYY-MM`. */
  period: string;
  status: ExtractionPackageStatus;
  pdf_href: string;
  pdf_sha256?: string;
  manifest: Record<string, unknown>;
  built_at: string;
}

export interface ExtractionPackageListOptions {
  publisher_id?: string;
  period?: string;
}

/** `GET /v1/source-versions/:id/content` without `?format=sections`. */
export interface SourceVersionContent {
  content: string;
}

/** Normalized [0, 1] bounding box on a PDF page (from Parse layout at ingest). */
export interface ExtractionBbox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One heading-bounded slice of a source version's canonical markdown. */
export interface ExtractionDocumentSection {
  index: number;
  heading: string;
  start_offset: number;
  end_offset: number;
  text?: string;
  /** 1-indexed page when Parse layout was stored for this version. */
  page?: number;
  /** Normalized [0, 1] bbox on `page` when available. */
  bbox?: ExtractionBbox;
}

/** Locates one extracted record in the source PDF via its section + layout. */
export interface ExtractionRecordEvidence {
  section_index: number;
  page: number;
  bbox: ExtractionBbox;
  block_ids?: string[];
}

/** `GET /v1/source-versions/:id/content?format=sections`. */
export interface SourceVersionSections {
  sections: ExtractionDocumentSection[];
}

/** `PATCH /v1/sources/:id` — bind (or unbind, with `null`) the extraction schema a source runs. */
export interface UpdateSourceInput {
  id: string;
  extraction_schema_id: string | null;
  /** Fill-missing re-extract versions that already ran under another schema. Default false. */
  reprocess?: boolean;
}

/**
 * Bind result. Same watched source as today, plus `reprocess_queued` when `reprocess: true`
 * was accepted (how many versions were queued for fill-missing extract).
 */
export type UpdateSourceResult = WatchedSource & {
  reprocess_queued?: number;
};

/* ------------------------------ webhook payloads ----------------------------- */

export const EXTRACTION_DOCUMENT_EVENT_TYPE = "extraction.document";
export const EXTRACTION_PACKAGE_EVENT_TYPE = "extraction.package";
export const EXTRACTION_EVENT_TYPES = [
  EXTRACTION_DOCUMENT_EVENT_TYPE,
  EXTRACTION_PACKAGE_EVENT_TYPE,
] as const;
export type ExtractionEventType = (typeof EXTRACTION_EVENT_TYPES)[number];

/** The body of an inbound `extraction.document` webhook. */
export interface ExtractionDocumentEvent {
  specversion: "1.0";
  id: string;
  type: typeof EXTRACTION_DOCUMENT_EVENT_TYPE;
  source: string;
  subject: string;
  time: string;
  correlation_id: string;
  sequence: number;
  data: {
    workspace_id: string;
    publisher_id: string;
    /** Still accepted on the wire for one release if a host has not flipped the field. */
    payer_id?: string;
    source_version_id: string;
    /**
     * `new` — first content version. `updated` — later version of the same source.
     * `schema_changed` — same PDF extracted again under a newly bound schema.
     * Match `schema_changed` to the earlier extract on `source_version_id` (also
     * envelope `correlation_id`).
     */
    source_change?: "new" | "updated" | "schema_changed";
    source_id?: string;
    /** Present only when this extract is a later generation of the same identity. */
    generation?: number;
    /** Durable Kaval source-version PDF URL — not a short-lived parser studio link. */
    pdf_href: string;
    content_href: string;
    sections: ExtractionDocumentSection[];
    extraction_run: ExtractionRun;
    /** Present when a schema was bound; absent for content-only delivery. */
    extraction?: {
      records: unknown[];
      run_href: string;
      /** Parallel to `records`; empty array when a record has no locatable section. */
      record_evidence?: ExtractionRecordEvidence[][];
    };
  };
}

/** The body of an inbound `extraction.package` webhook. */
export interface ExtractionPackageEvent {
  specversion: "1.0";
  id: string;
  type: typeof EXTRACTION_PACKAGE_EVENT_TYPE;
  source: string;
  subject: string;
  time: string;
  correlation_id: string;
  sequence: number;
  data: {
    workspace_id: string;
    package: ExtractionPackage;
  };
}

export type ExtractionWebhookEvent =
  ExtractionDocumentEvent | ExtractionPackageEvent;
