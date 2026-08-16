import { describe, expect, it } from "vitest";
import { EXTRACTION_EVENT_TYPES, Kaval } from "../src/index.js";

interface RequestRecord {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}

function extractionApi(): {
  fetch: typeof fetch;
  requests: RequestRecord[];
} {
  const requests: RequestRecord[] = [];
  const schemaId = "10000000-0000-4000-8000-000000000001";
  const runId = "20000000-0000-4000-8000-000000000001";
  const packageId = "30000000-0000-4000-8000-000000000001";
  const sourceId = "40000000-0000-4000-8000-000000000001";
  const versionId = "50000000-0000-4000-8000-000000000001";

  const fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      key: new Headers(init?.headers).get("idempotency-key"),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    let payload: unknown;
    let status = 200;
    if (url.pathname === "/v1/extraction-schemas" && method === "POST") {
      status = 201;
      payload = {
        extraction_schema: {
          id: schemaId,
          workspace_id: "ws_1",
          name: "prior-auth",
          json_schema: { type: "object" },
          schema_sha256: "a".repeat(64),
          created_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (url.pathname === `/v1/extraction-schemas/${schemaId}`) {
      payload = {
        extraction_schema: {
          id: schemaId,
          workspace_id: "ws_1",
          name: "prior-auth",
          json_schema: { type: "object" },
          schema_sha256: "a".repeat(64),
          created_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (url.pathname === "/v1/extraction-schemas") {
      payload = { extraction_schemas: [] };
    } else if (url.pathname === "/v1/extraction-runs" && method === "POST") {
      status = 202;
      payload = {
        extraction_run: {
          id: runId,
          workspace_id: "ws_1",
          scope: "payer_period",
          publisher_id: "aetna",
          period: "2026-08",
          extraction_schema_id: schemaId,
          status: "processing",
          attempt_count: 0,
          created_at: "2026-08-06T00:00:00.000Z",
          updated_at: "2026-08-06T00:00:00.000Z",
        },
      };
    } else if (url.pathname === `/v1/extraction-runs/${runId}`) {
      payload = {
        extraction_run: {
          id: runId,
          workspace_id: "ws_1",
          scope: "payer_period",
          publisher_id: "aetna",
          period: "2026-08",
          extraction_schema_id: schemaId,
          status: "succeeded",
          attempt_count: 1,
          created_at: "2026-08-06T00:00:00.000Z",
          updated_at: "2026-08-06T00:00:05.000Z",
        },
      };
    } else if (url.pathname === "/v1/extraction-runs") {
      payload = { extraction_runs: [], next_cursor: null };
    } else if (url.pathname === `/v1/extraction-packages/${packageId}`) {
      payload = {
        package: {
          id: packageId,
          workspace_id: "ws_1",
          publisher_id: "aetna",
          period: "2026-08",
          status: "ready",
          pdf_href: "https://api.usekaval.com/v1/packages/1.pdf",
          manifest: {},
          built_at: "2026-08-06T00:00:10.000Z",
        },
      };
    } else if (url.pathname === "/v1/extraction-packages") {
      payload = { packages: [] };
    } else if (
      url.pathname === `/v1/sources/${sourceId}` &&
      method === "PATCH"
    ) {
      payload = {
        source: {
          id: sourceId,
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
          extraction_schema_id: schemaId,
          created_at: "2026-08-06T00:00:00.000Z",
        },
        ...((requests.at(-1)?.body as { reprocess?: boolean } | undefined)
          ?.reprocess === true
          ? { reprocess_queued: 3 }
          : {}),
      };
    } else if (
      url.pathname === `/v1/source-versions/${versionId}/content` &&
      url.searchParams.get("format") === "sections"
    ) {
      payload = {
        sections: [
          {
            index: 0,
            heading: "Prior authorization",
            start_offset: 0,
            end_offset: 42,
          },
        ],
      };
    } else if (url.pathname === `/v1/source-versions/${versionId}/content`) {
      payload = { content: "# Prior authorization\n..." };
    } else {
      status = 404;
      payload = {
        error: { code: "not_found", message: "unmapped test route" },
      };
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { fetch, requests };
}

const SCHEMA_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const PACKAGE_ID = "30000000-0000-4000-8000-000000000001";
const SOURCE_ID = "40000000-0000-4000-8000-000000000001";
const VERSION_ID = "50000000-0000-4000-8000-000000000001";

describe("extraction client surface", () => {
  it("creates and reads extraction schemas with an idempotency key on the mutation", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const created = await client.createExtractionSchema({
      name: "prior-auth",
      json_schema: { type: "object" },
    });
    expect(created.id).toBe(SCHEMA_ID);
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/extraction-schemas",
    });
    expect(api.requests[0]?.key).toBeTruthy();

    const fetched = await client.getExtractionSchema(SCHEMA_ID);
    expect(fetched.name).toBe("prior-auth");

    const schemas = await client.listExtractionSchemas();
    expect(schemas).toEqual([]);
  });

  it("creates a publisher + period run and lists/gets it", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const run = await client.createExtractionRun({
      publisher_id: "aetna",
      period: "2026-08",
      extraction_schema_id: SCHEMA_ID,
    });
    expect(run.id).toBe(RUN_ID);
    expect(run.status).toBe("processing");
    const createRequest = api.requests.find(
      (request) =>
        request.method === "POST" && request.path === "/v1/extraction-runs",
    );
    expect(createRequest?.key).toBeTruthy();
    expect(createRequest?.body).toMatchObject({ publisher_id: "aetna" });

    const fetched = await client.getExtractionRun(RUN_ID);
    expect(fetched.status).toBe("succeeded");

    const runs = await client.listExtractionRuns({
      publisher_id: "aetna",
      period_from: "2026-01",
      period_to: "2026-08",
    });
    expect(runs).toEqual({ extraction_runs: [], next_cursor: null });
    const listRequest = api.requests.find(
      (request) =>
        request.method === "GET" &&
        request.path.startsWith("/v1/extraction-runs?"),
    );
    expect(listRequest?.path).toBe(
      "/v1/extraction-runs?publisher_id=aetna&period_from=2026-01&period_to=2026-08",
    );

    const expanded = await client.listExtractionRuns({
      expand: "document",
      updated_since: "2026-03-01T00:00:00.000Z",
      limit: 25,
    });
    expect(expanded).toEqual({ extraction_runs: [], next_cursor: null });
    const expandRequest = api.requests.find(
      (request) =>
        request.method === "GET" && request.path.includes("expand=document"),
    );
    expect(expandRequest?.path).toContain("updated_since=");
    expect(expandRequest?.path).toContain("limit=25");
  });

  it("gets and lists monthly packages", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const pkg = await client.getExtractionPackage(PACKAGE_ID);
    expect(pkg.status).toBe("ready");

    const packages = await client.listExtractionPackages({
      publisher_id: "aetna",
    });
    expect(packages).toEqual([]);
  });

  it("binds an extraction schema to a source with updateSource", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const source = await client.updateSource({
      id: SOURCE_ID,
      extraction_schema_id: SCHEMA_ID,
    });
    expect(source.extraction_schema_id).toBe(SCHEMA_ID);
  });

  it("forwards reprocess on updateSource", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const source = await client.updateSource({
      id: SOURCE_ID,
      extraction_schema_id: SCHEMA_ID,
      reprocess: true,
    });
    expect(source.reprocess_queued).toBe(3);
    expect(api.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/sources/${SOURCE_ID}`,
      body: { extraction_schema_id: SCHEMA_ID, reprocess: true },
    });
  });

  it("reads source version content as text or as sections", async () => {
    const api = extractionApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });

    const content = await client.getSourceVersionContent(VERSION_ID);
    expect(content).toEqual({ content: "# Prior authorization\n..." });

    const sections = await client.getSourceVersionContent(VERSION_ID, {
      format: "sections",
    });
    expect(sections).toEqual({
      sections: [
        {
          index: 0,
          heading: "Prior authorization",
          start_offset: 0,
          end_offset: 42,
        },
      ],
    });
  });

  it("subscribes to both extraction event types", async () => {
    const api = extractionApi();
    const client = new Kaval({
      apiKey: "kv_live_test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : (input as URL).href,
        );
        if (url.pathname === "/v1/webhooks") {
          const body = JSON.parse(String(init?.body));
          return {
            ok: true,
            status: 201,
            json: async () => ({
              subscription: { id: "sub_1", ...body },
              webhook_verification: { secret: "whsec_test" },
            }),
          } as Response;
        }
        return api.fetch(input, init);
      }) as unknown as typeof fetch,
    });

    const result = await client.subscribeExtractions({
      callback_url: "https://example.com/webhooks/kaval",
    });
    expect(result.subscription).toMatchObject({
      subscription_kind: "extraction",
      event_types: [...EXTRACTION_EVENT_TYPES],
    });
    expect(EXTRACTION_EVENT_TYPES).toEqual([
      "extraction.document",
      "extraction.package",
    ]);
  });
});
