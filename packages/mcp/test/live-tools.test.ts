/**
 * Opt-in live test: core MCP tools → real /v1/* on the hosted API.
 * Run: KAVAL_API_KEY=kv_live_… pnpm test test/live-tools.test.ts
 * Point at a local server with KAVAL_BASE_URL=http://localhost:4000.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createClientFromEnv } from "../src/env.js";
import { createMcpServer } from "../src/server.js";
import { parseToolText } from "./helpers/fake-api.js";

const apiKey = process.env.KAVAL_API_KEY;
const VERDICTS = new Set(["ALLOW", "REVIEW", "BLOCK"]);
const REASON_CODES = new Set([
  "ALL_FACTS_HOLD",
  "FACT_CHANGED",
  "FACT_EXPIRED",
  "FACT_UNKNOWN",
  "SOURCE_UPDATED_PENDING_REVIEW",
  "SOURCE_UNREACHABLE",
  "NEW_FACT_UNVERIFIED",
  "COMPILATION_UNCERTAIN",
]);

async function connectLiveClient(): Promise<McpClient> {
  // Build the client exactly the way the shipped bin does — including its transport deadline. A
  // hand-rolled `new Kaval(...)` here would have tested a client no user ever runs.
  const server = createMcpServer(createClientFromEnv());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "live-tools", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function expectToolOk(res: unknown) {
  expect((res as { isError?: boolean }).isError).not.toBe(true);
  return parseToolText(res);
}

describe.skipIf(!apiKey)("MCP live tools (hosted API)", () => {
  it("check → /v1/check returns a verdict, reason codes, and a receipt", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "check",
        arguments: {
          action: "Publish a note stating that Tim Cook is the CEO of Apple",
          origin_urls: ["https://www.apple.com/leadership/"],
        },
      }),
    );
    expect(VERDICTS.has(String(out.decision))).toBe(true);
    expect(Array.isArray(out.reason_codes)).toBe(true);
    for (const code of out.reason_codes ?? []) {
      expect(REASON_CODES.has(code)).toBe(true);
    }
    expect(typeof out.receipt?.id).toBe("string");
    expect(typeof out.latency_ms?.total).toBe("number");
  }, 120_000);

  it("check with structured claims takes the zero-extraction path", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "check",
        arguments: {
          claims: [
            {
              subject: "Apple",
              predicate: "chief_executive_officer",
              object: "Tim Cook",
            },
          ],
          mode: "fast",
        },
      }),
    );
    expect(VERDICTS.has(String(out.decision))).toBe(true);
    expect(out.facts?.length).toBeGreaterThan(0);
  }, 120_000);

  it("get_receipt → /v1/receipts/:id returns the signed document behind a check", async () => {
    const client = await connectLiveClient();
    const check = expectToolOk(
      await client.callTool({
        name: "check",
        arguments: {
          action: "Publish a note stating that Tim Cook is the CEO of Apple",
          mode: "fast",
        },
      }),
    );
    const out = expectToolOk(
      await client.callTool({
        name: "get_receipt",
        arguments: { receipt_id: check.receipt!.id! },
      }),
    );
    expect(out.receipt?.id).toBe(check.receipt?.id);
    // The whole point of the tool: the fields `check` does not return.
    expect(typeof out.receipt?.decision_rule_version).toBe("string");
    expect(Array.isArray(out.receipt?.facts)).toBe(true);
  }, 120_000);

  it("add_source → list_sources → remove_source round-trips through the registry", async () => {
    const client = await connectLiveClient();
    const created = expectToolOk(
      await client.callTool({
        name: "create_publisher",
        arguments: { name: `Live test ${Date.now()}` },
      }),
    );
    const publisherId = String(
      (created as { publisher?: { id?: string } }).publisher?.id ?? "",
    );
    expect(publisherId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const added = expectToolOk(
      await client.callTool({
        name: "add_source",
        arguments: {
          kind: "url",
          locator: "https://www.apple.com/leadership/",
          intent: "executive leadership roster",
          publisher_id: publisherId,
        },
      }),
    );
    const sourceId = added.source?.["id"];
    expect(typeof sourceId).toBe("string");

    const listed = expectToolOk(
      await client.callTool({ name: "list_sources", arguments: {} }),
    );
    expect(Array.isArray(listed.sources)).toBe(true);
    expect(listed.sources?.some((source) => source["id"] === sourceId)).toBe(
      true,
    );

    // Leaving the source behind would spend one slot of the tenant's active-source cap per run.
    const removed = expectToolOk(
      await client.callTool({
        name: "remove_source",
        arguments: { id: String(sourceId) },
      }),
    );
    expect(removed.deleted).toBe(true);
  }, 120_000);

  it("report_outcome → /v1/report-outcome accepts the receipt id from a check", async () => {
    const client = await connectLiveClient();
    const check = expectToolOk(
      await client.callTool({
        name: "check",
        arguments: {
          action: "Publish a note stating that Tim Cook is the CEO of Apple",
          mode: "fast",
        },
      }),
    );
    expect(typeof check.receipt?.id).toBe("string");

    const out = expectToolOk(
      await client.callTool({
        name: "report_outcome",
        arguments: {
          id: check.receipt!.id!,
          kind: "relied_and_correct",
          note: "mcp live-tools test",
        },
      }),
    );
    expect(out.ok).toBe(true);
  }, 120_000);

  it("list_training_feedback reads the explicit-consent review queue", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "list_training_feedback",
        arguments: { limit: 10 },
      }),
    ) as Record<string, unknown>;
    expect(out["schema_version"]).toBe("training-feedback-review-list/1.0.0");
    expect(Array.isArray(out["feedback"])).toBe(true);
  }, 120_000);

  it("list_bulletin_extraction_attempts reads customer-visible status", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "list_bulletin_extraction_attempts",
        arguments: { limit: 10 },
      }),
    ) as Record<string, unknown>;
    expect(out["schema_version"]).toBe("bulletin-extraction-attempt/1.0.0");
    expect(Array.isArray(out["data"])).toBe(true);
  }, 120_000);

  it("verify (deprecated alias) → /v1/verify still returns a signed proof receipt", async () => {
    const client = await connectLiveClient();
    const out = expectToolOk(
      await client.callTool({
        name: "verify",
        arguments: {
          conclusion: "Tim Cook is the CEO of Apple",
          evidence_refs: ["https://www.apple.com/leadership/"],
        },
      }),
    );
    expect(["valid", "invalidated", "could_not_verify"]).toContain(
      String(out.status),
    );
    expect(typeof out.receipt?.proof_id).toBe("string");
    expect(VERDICTS.has(String(out.receipt?.decision))).toBe(true);
  }, 180_000);
});
