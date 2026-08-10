import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kaval } from "@usekaval/kaval";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import {
  fakeAddSourceResult,
  fakeCheckReceipt,
  fakeCheckResult,
  fakeKavalFetch,
  fakeReceiptId,
  fakeSourceId,
  fakeVerifyReceipt,
  fakeVerifyRequest,
  failingKavalFetch,
  parseToolText,
  retiredKavalFetch,
} from "./helpers/fake-api.js";

/**
 * MCP is a thin client: a request goes MCP tool → `kaval` HTTP client → the hosted `/v1/*` API.
 * We inject a fake `fetch` that returns canned `/v1/*` responses in the EXACT live wire shapes, so
 * this exercises the MCP layer and the tool→client arg threading without touching the network or
 * the (private) engine.
 *
 * For registry-shaped installs (packed tarballs, not workspace symlinks), see published-artifacts.test.ts.
 */
async function connectClient(
  fetchImpl: typeof fetch = fakeKavalFetch,
): Promise<McpClient> {
  const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fetchImpl });
  const server = createMcpServer(kaval);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "conformance-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** Capture path + method + idempotency key + JSON body of the single request a tool call makes. */
function capturingFetch(payload: unknown): {
  fetchImpl: typeof fetch;
  seen: () => {
    path: string;
    method: string;
    key: string | null;
    body: Record<string, unknown> | null;
  };
} {
  let captured:
    | {
        path: string;
        method: string;
        key: string | null;
        body: Record<string, unknown> | null;
      }
    | undefined;
  const fetchImpl = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    captured = {
      path: new URL(url).pathname + new URL(url).search,
      method: (init?.method ?? "GET").toUpperCase(),
      key: new Headers(init?.headers).get("idempotency-key"),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    seen: () => {
      if (!captured) throw new Error("the fake API was never called");
      return captured;
    },
  };
}

describe("MCP conformance", () => {
  it("exposes exactly the collapsed tool surface — check first, no retired tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // This snapshot includes the check, its proof, portfolio reads, source controls, and feedback.
    // The deprecated pilot alias stays last.
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
      "create_policy_update",
      "get_policy_update",
      "list_policy_updates",
      "list_policy_update_packages",
      "add_source",
      "list_sources",
      "remove_source",
      "update_source",
      "get_source_version_content",
      "report_outcome",
      "verify",
    ]);
    for (const tool of tools) {
      expect(`${tool.name} ${tool.description}`).not.toMatch(
        /offer|product[_ ]research|commerce|quote|purchase|checkout|merchant|seller/i,
      );
    }
  });

  it("gives an agent enough description to pick check without reading docs", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const check = tools.find((tool) => tool.name === "check");
    expect(check?.description).toMatch(/ALLOW/);
    expect(check?.description).toMatch(/REVIEW/);
    expect(check?.description).toMatch(/BLOCK/);
    // REVIEW is not permission to act, and an agent must be told so in the tool text itself.
    expect(check?.description).toMatch(/REVIEW IS NEVER PERMISSION TO ACT/);
    // The deprecated alias must point at its replacement by name.
    const verify = tools.find((tool) => tool.name === "verify");
    expect(verify?.description).toMatch(/DEPRECATED/);
    expect(verify?.description).toMatch(/`check`/);
  });

  it("check forwards the action body to /v1/check and returns the verdict verbatim", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeCheckResult);
    const client = await connectClient(fetchImpl);
    const args = {
      action: "Approve this prior-authorization request at the in-network rate",
      context: "payer: Aetna; CPT 12345",
      materiality: "critical",
      max_wait_ms: 3_000,
    };
    const res = await client.callTool({ name: "check", arguments: args });
    const out = parseToolText(res);

    expect(seen()).toEqual({
      path: "/v1/check",
      method: "POST",
      // A check is a read of current state — the server does not replay it, so no key is spent.
      key: null,
      body: args,
    });
    expect(out).toEqual(fakeCheckResult);
    expect(out.decision).toBe("BLOCK");
    expect(out.reason_codes).toEqual(["FACT_CHANGED"]);
    expect(out.facts?.[0]?.status).toBe("changed");
    expect(out.facts?.[0]?.served_from_state).toBe(true);
    expect(out.receipt?.id).toBe(fakeReceiptId);
  });

  it("check accepts structured claims and forwards them unchanged (the zero-LLM path)", async () => {
    const { fetchImpl, seen } = capturingFetch({
      ...fakeCheckResult,
      decision: "ALLOW",
      reason_codes: ["ALL_FACTS_HOLD"],
    });
    const client = await connectClient(fetchImpl);
    const args = {
      claims: [
        {
          subject: "Aetna",
          predicate: "requires_prior_auth_for",
          object: "CPT 12345",
          scope: { plan: "HMO", state: "CA" },
          materiality: "critical",
        },
        "The 2024 IBC is the current edition",
      ],
      mode: "fast",
    };
    const res = await client.callTool({ name: "check", arguments: args });

    expect(seen().body).toEqual({ ...args, max_wait_ms: 45_000 });
    expect(parseToolText(res).decision).toBe("ALLOW");
  });

  it("sends an explicit research budget that fits inside the MCP request deadline", async () => {
    // The API's own default is 100s. Inheriting it would put every cold check past the 60s at which
    // the MCP caller cancels, so the agent would get a dead request instead of a verdict.
    const { fetchImpl, seen } = capturingFetch(fakeCheckResult);
    const client = await connectClient(fetchImpl);
    await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund" },
    });
    expect(seen().body?.["max_wait_ms"]).toBe(45_000);
  });

  it("lets a caller ask for less research, including none at all", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeCheckResult);
    const client = await connectClient(fetchImpl);
    await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund", max_wait_ms: 0 },
    });
    // 0 disables research; it must survive the default, which `||` would have swallowed.
    expect(seen().body?.["max_wait_ms"]).toBe(0);
  });

  it("accepts a budget the API accepts and rejects only what the transport cannot carry", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeCheckResult);
    const client = await connectClient(fetchImpl);
    // 30s used to be refused locally by a bound of 15000 the server never had.
    await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund", max_wait_ms: 30_000 },
    });
    expect(seen().body?.["max_wait_ms"]).toBe(30_000);

    const overBudget = await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund", max_wait_ms: 90_000 },
    });
    expect((overBudget as { isError?: boolean }).isError).toBe(true);
  });

  it("states the real budget in the tool text and claims no background warm-up", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const check = tools.find((tool) => tool.name === "check");
    const budget = (
      check?.inputSchema as {
        properties?: { max_wait_ms?: { description?: string } };
      }
    ).properties?.max_wait_ms?.description;
    expect(budget).toContain("45000");
    expect(budget).toContain("100000");
    // The numbers the docs kept quoting after the engine abandoned them.
    expect(budget).not.toMatch(/default 3000|15000/);
    // A timed-out fact does NOT warm the next check: that check recompiles the action and asks
    // about different fingerprints, so it misses the state the detached audit wrote.
    expect(`${budget} ${check?.description}`).not.toMatch(
      /background|the next check is warm/i,
    );
  });

  it("check refuses a call with neither action nor claims before touching the network", async () => {
    let calls = 0;
    const client = await connectClient((async () => {
      calls += 1;
      throw new Error("the API must not be called for invalid tool input");
    }) as typeof fetch);
    const res = await client.callTool({
      name: "check",
      arguments: { context: "just context" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "bad_request" });
    expect(calls).toBe(0);
  });

  it("check rejects a credential-bearing origin URL before network access", async () => {
    const client = await connectClient(() => {
      throw new Error("the API must not be called for an invalid tool input");
    });
    const res = await client.callTool({
      name: "check",
      arguments: {
        action: "Cite the current edition",
        origin_urls: ["https://user:secret@example.com/codes"],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(
      (res as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain("must be an http(s) URL");
  });

  it("add_source registers an entity by name and reports what it resolved to", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeAddSourceResult);
    const client = await connectClient(fetchImpl);
    const args = {
      kind: "entity",
      name: "Aetna",
      intent: "payer policy bulletins",
      scope_keys: ["plan:HMO"],
    };
    const res = await client.callTool({ name: "add_source", arguments: args });
    const out = parseToolText(res);

    expect(seen()).toMatchObject({
      path: "/v1/sources",
      method: "POST",
      body: args,
    });
    expect(out.created).toBe(true);
    expect(out.resolved?.[0]?.origin).toBe("resolved");
  });

  it("add_source refuses a registration with no locator and no name", async () => {
    let calls = 0;
    const client = await connectClient((async () => {
      calls += 1;
      throw new Error("the API must not be called for invalid tool input");
    }) as typeof fetch);
    const res = await client.callTool({
      name: "add_source",
      arguments: { kind: "url" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({ error: "bad_request" });
    expect(calls).toBe(0);
  });

  it("list_sources GETs the registry and threads include_inactive", async () => {
    const client = await connectClient();
    const active = parseToolText(
      await client.callTool({ name: "list_sources", arguments: {} }),
    );
    expect(active.sources).toHaveLength(1);

    const all = parseToolText(
      await client.callTool({
        name: "list_sources",
        arguments: { include_inactive: true },
      }),
    );
    expect(all.sources).toHaveLength(2);
  });

  it("report_outcome round-trips without requiring an idempotency key", async () => {
    const { fetchImpl, seen } = capturingFetch({ ok: true });
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "report_outcome",
      arguments: {
        id: fakeReceiptId,
        kind: "relied_and_correct",
        note: "worked",
      },
    });
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    expect(seen()).toMatchObject({ path: "/v1/report-outcome", key: null });
    expect(parseToolText(res).ok).toBe(true);
  });

  it.each([
    {
      name: "a hallucinated receipt id",
      arguments: {
        id: "rcpt_01JKAVALCHECK00000000001",
        kind: "relied_and_correct",
      },
      expected: /id/,
    },
    {
      name: "a note past the server's 2048-char cap",
      arguments: {
        id: fakeReceiptId,
        kind: "relied_and_correct",
        note: "x".repeat(2_049),
      },
      expected: /note/,
    },
    {
      name: "a note carrying a null byte",
      arguments: {
        id: fakeReceiptId,
        kind: "relied_and_correct",
        note: "worked\u0000",
      },
      expected: /note/,
    },
  ])(
    // The server enforces all three; failing here names the offending field instead of returning a
    // bare round-trip bad_request.
    "report_outcome rejects $name locally, naming the field",
    async ({ arguments: arguments_, expected }) => {
      let calls = 0;
      const client = await connectClient((async () => {
        calls += 1;
        throw new Error("the API must not be called for invalid tool input");
      }) as typeof fetch);
      const res = await client.callTool({
        name: "report_outcome",
        arguments: arguments_,
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(
        (res as { content: Array<{ text: string }> }).content[0]?.text,
      ).toMatch(expected);
      expect(calls).toBe(0);
    },
  );

  it("get_receipt fetches the full signed document behind a check's receipt id", async () => {
    const client = await connectClient();
    const out = parseToolText(
      await client.callTool({
        name: "get_receipt",
        arguments: { receipt_id: fakeReceiptId },
      }),
    );
    expect(out.receipt).toEqual(fakeCheckReceipt);
    // The three things `check`'s receipt stub cannot give an agent that has to show its work.
    expect(out.receipt?.decision_rule_version).toBe("check-decision/1.0.0");
    expect(out.receipt?.facts?.[0]?.basis?.[0]).toMatchObject({
      source_locator: "https://www.aetna.com/health-care-professionals/",
      version_sha256_of: "canonical_text",
    });
    expect(out.receipt?.signature).toMatchObject({ algorithm: "Ed25519" });
  });

  it("get_receipt refuses a receipt id the receipt route could not even match", async () => {
    let calls = 0;
    const client = await connectClient((async () => {
      calls += 1;
      throw new Error("the API must not be called for invalid tool input");
    }) as typeof fetch);
    const res = await client.callTool({
      name: "get_receipt",
      arguments: { receipt_id: "rcpt_01JKAVALCHECK00000000001" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("remove_source DELETEs the source, which is the only thing that frees the cap", async () => {
    const { fetchImpl, seen } = capturingFetch({
      deleted: true,
      id: fakeSourceId,
    });
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "remove_source",
      arguments: { id: fakeSourceId },
    });
    expect(seen()).toMatchObject({
      path: `/v1/sources/${fakeSourceId}`,
      method: "DELETE",
      key: null,
    });
    expect(parseToolText(res).deleted).toBe(true);
  });

  it("verify still reaches /v1/verify with the pilot conclusion body", async () => {
    const { fetchImpl, seen } = capturingFetch(fakeVerifyReceipt);
    const client = await connectClient(fetchImpl);
    const res = await client.callTool({
      name: "verify",
      arguments: {
        ...fakeVerifyRequest,
        idempotency_key: "mcp-verify-operation-0001",
      },
    });
    const out = parseToolText(res);

    expect(seen()).toEqual({
      path: "/v1/verify",
      method: "POST",
      key: "mcp-verify-operation-0001",
      body: fakeVerifyRequest,
    });
    expect(out).toEqual(fakeVerifyReceipt);
    expect(out.receipt?.decision).toBe("ALLOW");
    expect(out.receipt?.packet?.signature?.algorithm).toBe("Ed25519");
  });

  it.each([
    {
      name: "an empty evidence_refs array",
      arguments: { ...fakeVerifyRequest, evidence_refs: [] },
    },
    {
      name: "a bare object without document_id",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: [{ url: "https://example.com/evidence" }],
      },
    },
    {
      name: "duplicate document_id values",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: [
          { url: "https://example.com/a", document_id: "doc-1" },
          { url: "https://example.com/b", document_id: "doc-1" },
        ],
      },
    },
    {
      name: "a credential-bearing evidence URL",
      arguments: {
        ...fakeVerifyRequest,
        evidence_refs: ["https://user:secret@example.com/evidence"],
      },
    },
    {
      name: "a missing conclusion",
      arguments: { evidence_refs: fakeVerifyRequest.evidence_refs },
    },
  ])(
    "verify rejects $name before network access",
    async ({ arguments: arguments_ }) => {
      let calls = 0;
      const client = await connectClient((async () => {
        calls += 1;
        throw new Error("the API must not be called for invalid tool input");
      }) as typeof fetch);
      const res = await client.callTool({
        name: "verify",
        arguments: arguments_,
      });

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(calls).toBe(0);
    },
  );

  it("translates a 410 tool_retired into an answer that names the check tool", async () => {
    const client = await connectClient(retiredKavalFetch);
    const res = await client.callTool({
      name: "verify",
      arguments: {
        conclusion: fakeVerifyRequest.conclusion,
        evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("tool_retired");
    expect(out.status).toBe(410);
    expect(out.message).toContain("`check`");
    // The replacement comes off the error the API sent, so the message stays true past 0.6 — it
    // used to tell a 0.6 client to upgrade to 0.6.
    expect(out.message).toContain("/v1/check");
    expect(out.message).not.toMatch(/upgrade/i);
  });

  it("propagates MCP cancellation into check's HTTP request", async () => {
    let calls = 0;
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const cancellableFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          markAborted();
          reject(signal?.reason ?? new Error("cancelled"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const client = await connectClient(cancellableFetch);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "check", arguments: { action: "Issue the refund" } },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort(new Error("caller cancelled"));
    await aborted;
    await pending.catch(() => undefined);
    expect(calls).toBe(1);
  });

  it("surfaces a subscription entitlement (402) as a clear named error, not 'internal error'", async () => {
    const client = await connectClient(
      failingKavalFetch(
        402,
        "subscription_required",
        "An active subscription is required to continue",
      ),
    );
    const res = await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("subscription_required");
    expect(out.message).toContain("subscription");
    expect(out.status).toBe(402);
    expect(out.idempotency_key).toBeUndefined();
  });

  it("surfaces a bogus key (401) as a clear invalid-key error, not 'internal error'", async () => {
    const client = await connectClient(
      failingKavalFetch(401, "unauthorized", "invalid API key"),
    );
    const res = await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("unauthorized");
    expect(out.message).toContain("invalid");
    expect(out.status).toBe(401);
  });

  it("reuses and returns an MCP recovery key when event persistence is still pending", async () => {
    const seenKeys: string[] = [];
    const pendingFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenKeys.push(
        new Headers(init?.headers).get("idempotency-key") ?? "missing",
      );
      return new Response(
        JSON.stringify({
          error: {
            code: "event_persistence_pending",
            message: "verification event is still being persisted",
          },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const client = await connectClient(pendingFetch);
    const operationKey = "mcp-logical-operation-0001";

    const res = await client.callTool({
      name: "verify",
      arguments: {
        conclusion: fakeVerifyRequest.conclusion,
        evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
        idempotency_key: operationKey,
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({
      error: "event_persistence_pending",
      status: 503,
      idempotency_key: operationKey,
    });
    expect(seenKeys).toEqual([operationKey, operationKey]);
  });

  it("returns the generated recovery key after a terminal transport ambiguity", async () => {
    const transportFailure = (async () => {
      throw new TypeError("connection reset after request write");
    }) as typeof fetch;
    const client = await connectClient(transportFailure);

    const res = await client.callTool({
      name: "verify",
      arguments: {
        conclusion: fakeVerifyRequest.conclusion,
        evidence_refs: ["https://codes.iccsafe.org/content/IBC2024V2.0"],
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(parseToolText(res)).toMatchObject({
      error: "request_ambiguous",
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("names a check that ran out of time, with the move that gets an answer", async () => {
    // The most likely failure on the cold path. "internal error" told the agent nothing and left it
    // with nothing to try.
    const timingOut = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as typeof fetch;
    const kaval = new Kaval({
      apiKey: "kv_live_test",
      fetch: timingOut,
      timeoutMs: 20,
    });
    const server = createMcpServer(kaval);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: "timeout-test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("timeout");
    expect(out.message).toContain("mode:'fast'");
    expect(out.message).toContain("max_wait_ms");
  });

  it("names an unreachable API instead of blaming itself for a mistyped base URL", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = await connectClient(unreachable);
    const res = await client.callTool({
      name: "check",
      arguments: { action: "Issue the refund" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const out = parseToolText(res);
    expect(out.error).toBe("network_unreachable");
    expect(out.message).toContain("KAVAL_BASE_URL");
  });

  it("warns verify's caller off the phrasing the tool's own name invites", async () => {
    // The API pipes `conclusion` through AssertableProposition, which rejects questions, role
    // prefixes, and "verify whether|if|that …" — exactly what a model reaching for a tool called
    // `verify` writes. `check`'s `action` has no such pipe, so only this one bites.
    const client = await connectClient();
    const { tools } = await client.listTools();
    const conclusion = (
      tools.find((tool) => tool.name === "verify")?.inputSchema as {
        properties?: { conclusion?: { description?: string } };
      }
    ).properties?.conclusion?.description;
    expect(conclusion).toMatch(/verify whether/i);
    expect(conclusion).toMatch(/statement/i);
    // And an example of the shape that is accepted, so the warning is actionable.
    expect(conclusion).toContain(
      "The 2024 International Building Code is the current IBC edition.",
    );
  });
});
