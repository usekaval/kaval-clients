import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { parseToolText } from "./helpers/fake-api.js";

const SCHEMA_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const PACKAGE_ID = "30000000-0000-4000-8000-000000000001";
const SOURCE_ID = "40000000-0000-4000-8000-000000000001";
const VERSION_ID = "50000000-0000-4000-8000-000000000001";

interface CapturedRequest {
  path: string;
  method: string;
  key: string | null;
  body: Record<string, unknown> | null;
}

function policyUpdatesFetch(): {
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
    if (parsed.pathname === "/v1/extraction-schemas" && method === "POST") {
      response = {
        extraction_schema: {
          id: SCHEMA_ID,
          workspace_id: "ws_1",
          name: "prior-auth",
          json_schema: { type: "object" },
          schema_sha256: "a".repeat(64),
          created_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (parsed.pathname === "/v1/extraction-schemas") {
      response = {
        extraction_schemas: [
          {
            id: SCHEMA_ID,
            workspace_id: "ws_1",
            name: "prior-auth",
            json_schema: { type: "object" },
            schema_sha256: "a".repeat(64),
            created_at: "2026-08-06T00:00:00.000Z",
          },
        ],
      };
    } else if (parsed.pathname === "/v1/policy-updates" && method === "POST") {
      response = {
        extraction_run: {
          id: RUN_ID,
          workspace_id: "ws_1",
          scope: "payer_period",
          payer_id: "aetna",
          period: "2026-08",
          extraction_schema_id: SCHEMA_ID,
          status: "processing",
          attempt_count: 0,
          created_at: "2026-08-06T00:00:00.000Z",
          updated_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (parsed.pathname === `/v1/policy-updates/${RUN_ID}`) {
      response = {
        extraction_run: {
          id: RUN_ID,
          workspace_id: "ws_1",
          scope: "payer_period",
          payer_id: "aetna",
          period: "2026-08",
          extraction_schema_id: SCHEMA_ID,
          status: "succeeded",
          attempt_count: 1,
          created_at: "2026-08-06T00:00:00.000Z",
          updated_at: "2026-08-06T00:00:05.000Z",
        },
      };
    } else if (parsed.pathname === "/v1/policy-updates") {
      response = { extraction_runs: [] };
    } else if (parsed.pathname === "/v1/policy-update-packages") {
      response = {
        packages: [
          {
            id: PACKAGE_ID,
            workspace_id: "ws_1",
            payer_id: "aetna",
            period: "2026-08",
            status: "ready",
            pdf_href: "https://api.usekaval.com/v1/packages/1.pdf",
            manifest: {},
            built_at: "2026-08-06T00:00:10.000Z",
          },
        ],
      };
    } else if (
      parsed.pathname === `/v1/sources/${SOURCE_ID}` &&
      method === "PATCH"
    ) {
      response = {
        source: {
          id: SOURCE_ID,
          kind: "entity",
          locator: "Aetna",
          intent: "payer policy bulletins",
          origin: "registered",
          scope_keys: [],
          active: true,
          poll_interval_s: 3_600,
          next_poll_at: null,
          last_success_at: null,
          content_sha256: null,
          extraction_schema_id: body(init)?.extraction_schema_id ?? null,
          created_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (
      parsed.pathname === `/v1/source-versions/${VERSION_ID}/content` &&
      parsed.searchParams.get("format") === "sections"
    ) {
      response = {
        sections: [
          {
            index: 0,
            heading: "Prior authorization",
            start_offset: 0,
            end_offset: 42,
          },
        ],
      };
    } else if (
      parsed.pathname === `/v1/source-versions/${VERSION_ID}/content`
    ) {
      response = { content: "# Prior authorization\n..." };
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

  function body(init: RequestInit | undefined): Record<string, unknown> {
    return init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
  }
}

async function connect(fetch: typeof globalThis.fetch): Promise<McpClient> {
  const server = createMcpServer(new Kaval({ apiKey: "kv_live_test", fetch }));
  const client = new McpClient({
    name: "policy-updates-test",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("MCP policy-update tools", () => {
  it("creates an extraction schema with an idempotency key and lists them back", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const created = parseToolText(
      await client.callTool({
        name: "create_extraction_schema",
        arguments: {
          name: "prior-auth",
          json_schema: { type: "object" },
          idempotency_key: "schema-operation-001",
        },
      }),
    ) as { id?: string };
    expect(created.id).toBe(SCHEMA_ID);
    expect(harness.requests[0]).toMatchObject({
      path: "/v1/extraction-schemas",
      method: "POST",
      key: "schema-operation-001",
    });

    const listed = parseToolText(
      await client.callTool({ name: "list_extraction_schemas", arguments: {} }),
    ) as { extraction_schemas?: Array<{ id?: string }> };
    expect(listed.extraction_schemas?.[0]?.id).toBe(SCHEMA_ID);
  });

  it("requests a payer + period run, gets it, and lists runs with filters", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const created = parseToolText(
      await client.callTool({
        name: "create_policy_update",
        arguments: {
          payer_id: "aetna",
          period: "2026-08",
          extraction_schema_id: SCHEMA_ID,
          idempotency_key: "run-operation-001",
        },
      }),
    ) as { status?: string };
    expect(created.status).toBe("processing");
    expect(harness.requests[0]).toMatchObject({
      path: "/v1/policy-updates",
      method: "POST",
      key: "run-operation-001",
    });

    const fetched = parseToolText(
      await client.callTool({
        name: "get_policy_update",
        arguments: { run_id: RUN_ID },
      }),
    ) as { status?: string };
    expect(fetched.status).toBe("succeeded");

    const listed = parseToolText(
      await client.callTool({
        name: "list_policy_updates",
        arguments: { payer_id: "aetna", period: "2026-08" },
      }),
    ) as { policy_updates?: unknown[] };
    expect(listed.policy_updates).toEqual([]);
    expect(harness.requests.at(-1)).toMatchObject({
      path: "/v1/policy-updates?payer_id=aetna&period=2026-08",
      method: "GET",
    });
  });

  it("lists monthly policy-update packages filtered by payer and period", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const listed = parseToolText(
      await client.callTool({
        name: "list_policy_update_packages",
        arguments: { payer_id: "aetna", period: "2026-08" },
      }),
    ) as { policy_update_packages?: Array<{ id?: string }> };
    expect(listed.policy_update_packages?.[0]?.id).toBe(PACKAGE_ID);
    expect(harness.requests[0]).toMatchObject({
      path: "/v1/policy-update-packages?payer_id=aetna&period=2026-08",
      method: "GET",
    });
  });

  it("binds an extraction schema to a source with update_source", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const updated = parseToolText(
      await client.callTool({
        name: "update_source",
        arguments: { id: SOURCE_ID, extraction_schema_id: SCHEMA_ID },
      }),
    ) as { extraction_schema_id?: string };
    expect(updated.extraction_schema_id).toBe(SCHEMA_ID);
    expect(harness.requests[0]).toMatchObject({
      path: `/v1/sources/${SOURCE_ID}`,
      method: "PATCH",
      body: { extraction_schema_id: SCHEMA_ID },
    });
  });

  it("unbinds an extraction schema by passing extraction_schema_id: null", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    await client.callTool({
      name: "update_source",
      arguments: { id: SOURCE_ID, extraction_schema_id: null },
    });
    expect(harness.requests[0]).toMatchObject({
      path: `/v1/sources/${SOURCE_ID}`,
      method: "PATCH",
      body: { extraction_schema_id: null },
    });
  });

  it("reads source version content as text or as pre-split sections", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const text = parseToolText(
      await client.callTool({
        name: "get_source_version_content",
        arguments: { source_version_id: VERSION_ID },
      }),
    ) as { content?: string };
    expect(text.content).toBe("# Prior authorization\n...");

    const sections = parseToolText(
      await client.callTool({
        name: "get_source_version_content",
        arguments: { source_version_id: VERSION_ID, format: "sections" },
      }),
    ) as { sections?: Array<{ heading?: string }> };
    expect(sections.sections?.[0]?.heading).toBe("Prior authorization");
    expect(harness.requests.at(-1)?.path).toBe(
      `/v1/source-versions/${VERSION_ID}/content?format=sections`,
    );
  });

  it("rejects malformed policy-update input before touching the network", async () => {
    const harness = policyUpdatesFetch();
    const client = await connect(harness.fetch);

    const badPeriod = await client.callTool({
      name: "create_policy_update",
      arguments: {
        payer_id: "aetna",
        period: "2026-8",
        extraction_schema_id: SCHEMA_ID,
      },
    });
    expect((badPeriod as { isError?: boolean }).isError).toBe(true);

    const oversizedSchema = await client.callTool({
      name: "create_extraction_schema",
      arguments: {
        name: "too-big",
        json_schema: { description: "x".repeat(70_000) },
      },
    });
    expect((oversizedSchema as { isError?: boolean }).isError).toBe(true);

    const badFormat = await client.callTool({
      name: "get_source_version_content",
      arguments: { source_version_id: VERSION_ID, format: "raw" },
    });
    expect((badFormat as { isError?: boolean }).isError).toBe(true);

    expect(harness.requests).toHaveLength(0);
  });
});
