import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { parseToolText } from "./helpers/fake-api.js";

const CONTRACT_ID = "10000000-0000-4000-8000-000000000001";
const CLAIM_ID = "20000000-0000-4000-8000-000000000001";
const BULLETIN_ID = "30000000-0000-4000-8000-000000000001";
const BULLETIN_ATTEMPT_ID = "31000000-0000-4000-8000-000000000001";
const IMPORT_ID = "40000000-0000-4000-8000-000000000001";
const JOB_ID = "50000000-0000-4000-8000-000000000001";
const SOURCE_ID = "60000000-0000-4000-8000-000000000001";
const FEEDBACK_ID = "90000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const KEY_ID = "b0000000-0000-4000-8000-000000000001";

interface CapturedRequest {
  path: string;
  method: string;
  key: string | null;
  body: Record<string, unknown> | null;
}

function portfolioFetch(): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetch = (async (input, init) => {
    const parsed = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      path: `${parsed.pathname}${parsed.search}`,
      method,
      key: new Headers(init?.headers).get("idempotency-key"),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null,
    });

    let response: unknown;
    if (parsed.pathname === "/v1/contract-uploads") {
      response = {
        id: "70000000-0000-4000-8000-000000000001",
        upload_url: "https://upload.test",
      };
    } else if (parsed.pathname === "/v1/contracts" && method === "POST") {
      response = { id: CONTRACT_ID, state: "queued" };
    } else if (parsed.pathname === `/v1/contracts/${CONTRACT_ID}`) {
      response = { id: CONTRACT_ID, state: "ready_for_review" };
    } else if (parsed.pathname === `/v1/contracts/${CONTRACT_ID}/claims`) {
      response = { data: [{ id: CLAIM_ID }], next_cursor: null };
    } else if (
      parsed.pathname === `/v1/contracts/${CONTRACT_ID}/extraction-issues`
    ) {
      response = {
        schema_version: "contract-extraction-issue/1.0.0",
        data: [
          {
            id: "21000000-0000-4000-8000-000000000001",
            contract_id: CONTRACT_ID,
            issue_code: "evidence_quote_not_exact",
          },
        ],
        next_cursor: "next-issue-page",
      };
    } else if (
      parsed.pathname ===
      `/v1/contracts/${CONTRACT_ID}/claims/${CLAIM_ID}/reviews`
    ) {
      response = {
        id: "80000000-0000-4000-8000-000000000001",
        decision: "approve",
      };
    } else if (parsed.pathname === "/v1/fact-imports") {
      response = { id: IMPORT_ID, state: "queued" };
    } else if (parsed.pathname === `/v1/fact-imports/${IMPORT_ID}`) {
      response = { id: IMPORT_ID, state: "completed", items: [] };
    } else if (parsed.pathname === "/v1/bulletins") {
      response = {
        bulletins: [{ source_version_id: BULLETIN_ID }],
        next_cursor: null,
      };
    } else if (parsed.pathname === `/v1/bulletins/${BULLETIN_ID}`) {
      response = {
        bulletin: {
          source_version_id: BULLETIN_ID,
          record_status: "confirmed",
        },
      };
    } else if (parsed.pathname === "/v1/bulletins/extraction-attempts") {
      response = {
        schema_version: "bulletin-extraction-attempt/1.0.0",
        data: [
          {
            id: BULLETIN_ATTEMPT_ID,
            source_version_id: BULLETIN_ATTEMPT_ID,
            source_id: SOURCE_ID,
            status: "failed",
          },
        ],
        next_cursor: "next-attempt-page",
      };
    } else if (
      parsed.pathname ===
      `/v1/bulletins/extraction-attempts/${BULLETIN_ATTEMPT_ID}`
    ) {
      response = {
        schema_version: "bulletin-extraction-attempt/1.0.0",
        data: {
          id: BULLETIN_ATTEMPT_ID,
          source_version_id: BULLETIN_ATTEMPT_ID,
          source_id: SOURCE_ID,
          status: "failed",
        },
      };
    } else if (parsed.pathname === "/v1/training-jobs") {
      response = {
        training_jobs: [{ id: JOB_ID, status: "insufficient_data" }],
        next_cursor: null,
      };
    } else if (parsed.pathname === `/v1/training-jobs/${JOB_ID}`) {
      response = { id: JOB_ID, status: "insufficient_data" };
    } else if (parsed.pathname === "/v1/training-feedback") {
      response = {
        schema_version: "training-feedback-review-list/1.0.0",
        feedback: [
          {
            feedback: {
              schema_version: "training-feedback/1.0.0",
              id: FEEDBACK_ID,
              workspace_id: WORKSPACE_ID,
              source_type: "contract_claim_review",
              source_id: "claim-review-001",
              split_group_id: "contract-family-001",
              task: "contract_claim_extraction",
              review_status: "accepted",
              training_use: "withheld",
              split: "training",
              input: { claim_text: "Claims must be filed within 120 days." },
              expected_output: { filing_limit_days: 120 },
              reviewed_by: "reviewer-001",
              reviewed_at: "2026-08-05T20:00:00.000Z",
              demo_only: false,
              content_hash: `sha256:${"a".repeat(64)}`,
            },
            effective_training_use: "withheld",
            latest_consent: null,
          },
        ],
        next_cursor: "next-feedback-page",
      };
    } else if (
      parsed.pathname === `/v1/training-feedback/${FEEDBACK_ID}/consent`
    ) {
      response = {
        schema_version: "training-feedback-consent/1.0.0",
        id: "c0000000-0000-4000-8000-000000000001",
        workspace_id: WORKSPACE_ID,
        feedback_id: FEEDBACK_ID,
        training_use: "approved",
        consent_to_training: true,
        reason: "The operator approved this reviewed example.",
        reviewed_by_api_key_id: KEY_ID,
        created_at: "2026-08-05T20:01:00.000Z",
      };
    } else {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(response), {
      status: method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function connect(fetch: typeof globalThis.fetch): Promise<McpClient> {
  const server = createMcpServer(new Kaval({ apiKey: "kv_live_test", fetch }));
  const client = new McpClient({ name: "portfolio-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function firstResourceJson(
  response: Awaited<ReturnType<McpClient["readResource"]>>,
): unknown {
  const content = response.contents[0];
  if (content === undefined || !("text" in content)) {
    throw new Error("the resource did not return JSON text");
  }
  return JSON.parse(content.text);
}

describe("MCP portfolio tools and resources", () => {
  it("publishes all new tools and keeps model promotion unavailable", async () => {
    const harness = portfolioFetch();
    const client = await connect(harness.fetch);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "check",
      "get_receipt",
      "prepare_contract_upload",
      "ingest_contract",
      "get_contract",
      "list_contract_claims",
      "list_contract_extraction_issues",
      "review_contract_claim",
      "import_facts",
      "get_fact_import",
      "list_bulletins",
      "get_bulletin",
      "list_bulletin_extraction_attempts",
      "get_bulletin_extraction_attempt",
      "list_training_jobs",
      "get_training_job",
      "list_training_feedback",
      "record_training_feedback_consent",
      "create_extraction_schema",
      "list_extraction_schemas",
      "create_extraction_run",
      "get_extraction_run",
      "list_extraction_runs",
      "list_extraction_packages",
      "add_source",
      "list_sources",
      "remove_source",
      "update_source",
      "get_source_version_content",
      "report_outcome",
      "verify",
    ]);
    expect(names).not.toContain("promote_model");
    expect(names).not.toContain("start_training_job");
    expect(names.some((name) => name.includes("requeue"))).toBe(false);

    const schemaFor = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as {
        properties?: Record<string, { maximum?: number; maxItems?: number }>;
      };
    expect(
      schemaFor("prepare_contract_upload").properties?.size_bytes?.maximum,
    ).toBe(26_214_400);
    expect(schemaFor("import_facts").properties?.items?.maxItems).toBe(400);
    expect(schemaFor("list_contract_claims").properties?.limit?.maximum).toBe(
      100,
    );
    expect(
      schemaFor("list_contract_extraction_issues").properties?.limit?.maximum,
    ).toBe(100);
    expect(schemaFor("list_bulletins").properties?.limit?.maximum).toBe(100);
    expect(
      schemaFor("list_bulletin_extraction_attempts").properties?.limit?.maximum,
    ).toBe(100);
    expect(schemaFor("list_training_jobs").properties?.limit?.maximum).toBe(
      100,
    );
    expect(schemaFor("list_training_feedback").properties?.limit?.maximum).toBe(
      100,
    );
  });

  it("publishes collection resources and identifier templates", async () => {
    const harness = portfolioFetch();
    const client = await connect(harness.fetch);
    expect(
      (await client.listResources()).resources.map((resource) => resource.uri),
    ).toEqual([
      "kaval://bulletins",
      "kaval://bulletins/extraction-attempts",
      "kaval://training-jobs",
      "kaval://training-feedback",
    ]);
    expect(
      (await client.listResourceTemplates()).resourceTemplates.map(
        (resource) => resource.uriTemplate,
      ),
    ).toEqual([
      "kaval://contracts/{contract_id}",
      "kaval://contracts/{contract_id}/claims",
      "kaval://contracts/{contract_id}/extraction-issues",
      "kaval://bulletins/{source_version_id}",
      "kaval://bulletins/extraction-attempts/{source_version_id}",
      "kaval://fact-imports/{import_id}",
      "kaval://training-jobs/{job_id}",
    ]);
  });

  it("forwards contract mutations with idempotency and reads contract resources", async () => {
    const harness = portfolioFetch();
    const client = await connect(harness.fetch);
    const prepared = parseToolText(
      await client.callTool({
        name: "prepare_contract_upload",
        arguments: {
          filename: "agreement.pdf",
          size_bytes: 100,
          sha256: "a".repeat(64),
          idempotency_key: "upload-operation-001",
        },
      }),
    );
    expect(prepared.id).toBe("70000000-0000-4000-8000-000000000001");

    await client.callTool({
      name: "ingest_contract",
      arguments: {
        external_id: "contract-001",
        title: "Signed agreement",
        document_type: "base_agreement",
        authority_status: "signed",
        contract_family_key: "payer-family-001",
        effective_from: "2026-01-01",
        effective_to: null,
        supersedes_contract_id: null,
        source: {
          kind: "canonical_text",
          content: "The filing limit is 120 days.",
        },
        idempotency_key: "contract-operation-001",
      },
    });
    await client.callTool({
      name: "review_contract_claim",
      arguments: {
        contract_id: CONTRACT_ID,
        claim_id: CLAIM_ID,
        review_id: "review-001",
        decision: "approve",
        expected_candidate_version: 1,
        reason: "Verified against the signed agreement.",
        idempotency_key: "review-operation-001",
      },
    });
    const resource = await client.readResource({
      uri: `kaval://contracts/${CONTRACT_ID}`,
    });
    expect(firstResourceJson(resource)).toMatchObject({
      id: CONTRACT_ID,
      state: "ready_for_review",
    });

    expect(harness.requests[0]).toMatchObject({
      path: "/v1/contract-uploads",
      key: "upload-operation-001",
    });
    expect(harness.requests[1]).toMatchObject({
      path: "/v1/contracts",
      key: "contract-operation-001",
    });
    expect(harness.requests[2]).toMatchObject({
      path: `/v1/contracts/${CONTRACT_ID}/claims/${CLAIM_ID}/reviews`,
      key: "review-operation-001",
    });
  });

  it("forwards filters and exposes bulk, bulletin, and training resources", async () => {
    const harness = portfolioFetch();
    const client = await connect(harness.fetch);
    await client.callTool({
      name: "list_contract_claims",
      arguments: {
        contract_id: CONTRACT_ID,
        status: "approved",
        activation_state: "active",
        limit: 25,
      },
    });
    await client.callTool({
      name: "list_contract_extraction_issues",
      arguments: {
        contract_id: CONTRACT_ID,
        issue_code: "evidence_quote_not_exact",
        cursor: "issue-cursor-001",
        limit: 25,
      },
    });
    await client.callTool({
      name: "import_facts",
      arguments: {
        external_batch_id: "seed-001",
        items: [
          {
            item_id: "fact-001",
            claim: {
              subject: "Example plan",
              predicate: "requires_prior_authorization",
              object: true,
              materiality: "high",
            },
            contract_claim_id: CLAIM_ID,
            source_ids: [SOURCE_ID],
          },
        ],
        idempotency_key: "fact-import-operation-001",
      },
    });
    await client.callTool({
      name: "list_bulletins",
      arguments: {
        payer_id: "aetna",
        code: "99213",
        record_status: "confirmed",
        published_from: "2026-01-01",
        published_to: "2026-08-05",
        limit: 25,
      },
    });
    await client.callTool({
      name: "list_bulletin_extraction_attempts",
      arguments: {
        source_id: SOURCE_ID,
        status: "failed",
        cursor: "attempt-cursor-001",
        limit: 25,
      },
    });
    await client.callTool({
      name: "get_bulletin_extraction_attempt",
      arguments: { source_version_id: BULLETIN_ATTEMPT_ID },
    });
    await client.callTool({
      name: "list_training_jobs",
      arguments: { status: "insufficient_data", demo_only: false, limit: 25 },
    });
    expect(
      parseToolText(
        await client.callTool({
          name: "list_training_feedback",
          arguments: {
            effective_training_use: "withheld",
            cursor: "feedback-cursor-001",
            limit: 25,
          },
        }),
      ),
    ).toMatchObject({
      feedback: [
        {
          feedback: { id: FEEDBACK_ID },
          effective_training_use: "withheld",
        },
      ],
    });
    await client.callTool({
      name: "record_training_feedback_consent",
      arguments: {
        feedback_id: FEEDBACK_ID,
        training_use: "approved",
        consent_to_training: true,
        reason: "The operator approved this reviewed example.",
        idempotency_key: "feedback-consent-operation-001",
      },
    });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/v1/contracts/${CONTRACT_ID}/claims?status=approved&activation_state=active&limit=25`,
      `/v1/contracts/${CONTRACT_ID}/extraction-issues?issue_code=evidence_quote_not_exact&cursor=issue-cursor-001&limit=25`,
      "/v1/fact-imports",
      "/v1/bulletins?payer_id=aetna&code=99213&record_status=confirmed&published_from=2026-01-01&published_to=2026-08-05&limit=25",
      `/v1/bulletins/extraction-attempts?source_id=${SOURCE_ID}&status=failed&cursor=attempt-cursor-001&limit=25`,
      `/v1/bulletins/extraction-attempts/${BULLETIN_ATTEMPT_ID}`,
      "/v1/training-jobs?status=insufficient_data&demo_only=false&limit=25",
      "/v1/training-feedback?effective_training_use=withheld&cursor=feedback-cursor-001&limit=25",
      `/v1/training-feedback/${FEEDBACK_ID}/consent`,
    ]);
    expect(harness.requests.at(-1)).toMatchObject({
      method: "POST",
      key: "feedback-consent-operation-001",
      body: {
        schema_version: "training-feedback-consent-request/1.0.0",
        training_use: "approved",
        consent_to_training: true,
        reason: "The operator approved this reviewed example.",
      },
    });

    for (const uri of [
      `kaval://fact-imports/${IMPORT_ID}`,
      `kaval://bulletins/${BULLETIN_ID}`,
      `kaval://training-jobs/${JOB_ID}`,
      `kaval://contracts/${CONTRACT_ID}/extraction-issues`,
      "kaval://bulletins",
      "kaval://bulletins/extraction-attempts",
      `kaval://bulletins/extraction-attempts/${BULLETIN_ATTEMPT_ID}`,
      "kaval://training-jobs",
      "kaval://training-feedback",
    ]) {
      const response = await client.readResource({ uri });
      expect(firstResourceJson(response)).not.toHaveProperty("error");
    }
  });

  it("rejects unsafe or inconsistent input before network access", async () => {
    const harness = portfolioFetch();
    const client = await connect(harness.fetch);
    const badReview = await client.callTool({
      name: "review_contract_claim",
      arguments: {
        contract_id: CONTRACT_ID,
        claim_id: CLAIM_ID,
        review_id: "review-002",
        decision: "correct",
        expected_candidate_version: 1,
      },
    });
    expect((badReview as { isError?: boolean }).isError).toBe(true);

    const duplicate = await client.callTool({
      name: "import_facts",
      arguments: {
        external_batch_id: "seed-002",
        items: [
          {
            item_id: "fact-duplicate",
            claim: { subject: "Plan", predicate: "covers", object: true },
            source_ids: [],
          },
          {
            item_id: "fact-duplicate",
            claim: { subject: "Plan", predicate: "covers", object: false },
            source_ids: [],
          },
        ],
      },
    });
    expect((duplicate as { isError?: boolean }).isError).toBe(true);

    const badDate = await client.callTool({
      name: "list_bulletins",
      arguments: { published_from: "2026-08-05", published_to: "2026-01-01" },
    });
    expect((badDate as { isError?: boolean }).isError).toBe(true);

    const badLimit = await client.callTool({
      name: "list_bulletins",
      arguments: { limit: 101 },
    });
    expect((badLimit as { isError?: boolean }).isError).toBe(true);

    const badAttemptStatus = await client.callTool({
      name: "list_bulletin_extraction_attempts",
      arguments: { status: "requeued" },
    });
    expect((badAttemptStatus as { isError?: boolean }).isError).toBe(true);

    const hiddenRequeueInput = await client.callTool({
      name: "list_bulletin_extraction_attempts",
      arguments: { status: "failed", requeue: true },
    });
    expect((hiddenRequeueInput as { isError?: boolean }).isError).toBe(true);

    const badIssueCode = await client.callTool({
      name: "list_contract_extraction_issues",
      arguments: { contract_id: CONTRACT_ID, issue_code: "raw_model_error" },
    });
    expect((badIssueCode as { isError?: boolean }).isError).toBe(true);

    const badTrainingUse = await client.callTool({
      name: "list_training_feedback",
      arguments: { effective_training_use: "implicit" },
    });
    expect((badTrainingUse as { isError?: boolean }).isError).toBe(true);

    const looseEntity = await client.callTool({
      name: "import_facts",
      arguments: {
        external_batch_id: "seed-003",
        items: [
          {
            item_id: "fact-loose-entity",
            claim: {
              subject: { name: "Plan", unrecognized: "must fail" },
              predicate: "covers",
              object: true,
            },
            source_ids: [],
          },
        ],
      },
    });
    expect((looseEntity as { isError?: boolean }).isError).toBe(true);

    const unsafeConsent = await client.callTool({
      name: "record_training_feedback_consent",
      arguments: {
        feedback_id: FEEDBACK_ID,
        training_use: "approved",
        consent_to_training: false,
      },
    });
    expect((unsafeConsent as { isError?: boolean }).isError).toBe(true);
    expect(harness.requests).toHaveLength(0);
  });

  it("keeps cross-tenant bulletin attempt failures customer-safe", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "bulletin_attempt_not_found",
            message: "no matching bulletin extraction attempt exists",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;
    const client = await connect(fetch);

    const tool = await client.callTool({
      name: "get_bulletin_extraction_attempt",
      arguments: { source_version_id: BULLETIN_ATTEMPT_ID },
    });
    expect((tool as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(tool)).toEqual({
      error: "bulletin_attempt_not_found",
      message: "no matching bulletin extraction attempt exists",
      status: 404,
    });

    const resource = firstResourceJson(
      await client.readResource({
        uri: `kaval://bulletins/extraction-attempts/${BULLETIN_ATTEMPT_ID}`,
      }),
    );
    expect(resource).toEqual({
      error: "bulletin_attempt_not_found",
      message: "no matching bulletin extraction attempt exists",
      status: 404,
    });
    expect(JSON.stringify({ tool: parseToolText(tool), resource })).not.toMatch(
      /workspace_id|tenant_id|sql|postgres/iu,
    );
  });

  it("returns the operation key after an ambiguous contract mutation", async () => {
    const client = await connect((async () => {
      throw new TypeError("connection reset after request write");
    }) as typeof fetch);
    const response = await client.callTool({
      name: "prepare_contract_upload",
      arguments: {
        filename: "agreement.pdf",
        size_bytes: 100,
        sha256: "a".repeat(64),
        idempotency_key: "contract-upload-recovery-001",
      },
    });
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(response)).toMatchObject({
      error: "request_ambiguous",
      idempotency_key: "contract-upload-recovery-001",
    });
  });
});
