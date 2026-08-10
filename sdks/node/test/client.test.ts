import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHECK_MAX_WAIT_MS,
  Kaval,
  KavalError,
  KavalRetiredError,
  MAX_CHECK_MAX_WAIT_MS,
  MIN_CHECK_MAX_WAIT_MS,
} from "../src/index.js";
import type {
  AddSourceResult,
  CalibrationSupportIdentity,
  CheckReceipt,
  CheckReceiptBasis,
  CheckResult,
  ClaimAssessment,
} from "../src/index.js";

type CalibrationSupportIsRequired = ClaimAssessment extends {
  calibration_support: CalibrationSupportIdentity;
}
  ? true
  : false;
const CALIBRATION_SUPPORT_IS_REQUIRED: CalibrationSupportIsRequired = true;

/** A fetch double: the handler decides status + JSON; we capture what the client sent. */
function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; json: unknown },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { status = 200, json } = handler(url, init);
    return {
      ok: status < 400,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
}

/** A fetch that never answers, so only the client's own deadline can end the call. */
function hangingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

/**
 * A receipt RECORDED from the server's own check pipeline, not written by hand here. A fixture
 * authored against the SDK's types can only ever agree with them; this one is the wire.
 */
const RECORDED_RECEIPT = JSON.parse(
  readFileSync(
    new URL("./fixtures/recorded-check-receipt.json", import.meta.url),
    "utf8",
  ),
) as CheckReceipt;

const CHECK_RESULT: CheckResult = {
  decision: "BLOCK",
  reason_codes: ["FACT_CHANGED"],
  facts: [
    {
      fingerprint: "fact:sha256:1111",
      text: "Aetna requires prior authorization for CPT 12345",
      status: "changed",
      materiality: "critical",
      served_from_state: true,
      last_verified_at: "2026-07-25T09:00:00.000Z",
      sources: [{ locator: "https://aetna.com/bulletins/2026-07" }],
    },
  ],
  receipt: {
    id: "rcpt_1",
    signature: "c2ln",
    signed_at: "2026-07-26T00:00:00.000Z",
  },
  latency_ms: { compile: 1, lookup: 8, live: 0, total: 11 },
};

const SOURCE = {
  id: "src_1",
  kind: "entity" as const,
  locator: "Aetna",
  intent: "payer policy bulletins",
  origin: "registered" as const,
  scope_keys: [],
  active: true,
  poll_interval_s: 3_600,
  next_poll_at: null,
  last_success_at: null,
  content_sha256: null,
  created_at: "2026-07-26T00:00:00.000Z",
};

describe("Kaval", () => {
  it("types issued claim assessments with required calibration support identity", () => {
    expect(CALIBRATION_SUPPORT_IS_REQUIRED).toBe(true);
  });

  it("check() posts the action body to /v1/check with bearer auth and returns the decision", async () => {
    let seen:
      | { url: string; auth?: string; idempotencyKey?: string; body: unknown }
      | undefined;
    const kaval = new Kaval({
      apiKey: "kv_live_abc",
      fetch: mockFetch((url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen = {
          url,
          auth: headers?.["authorization"],
          idempotencyKey: headers?.["idempotency-key"],
          body: JSON.parse(init?.body as string),
        };
        return { json: CHECK_RESULT };
      }),
    });

    const result = await kaval.check({
      action: "Approve the claim at the current rate",
      context: "payer: Aetna",
    });

    expect(seen?.url).toBe("https://api.usekaval.com/v1/check");
    expect(seen?.auth).toBe("Bearer kv_live_abc");
    // A check is a read of current state: the server does not replay it, so no key is spent.
    expect(seen?.idempotencyKey).toBeUndefined();
    expect(seen?.body).toEqual({
      action: "Approve the claim at the current rate",
      context: "payer: Aetna",
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason_codes).toEqual(["FACT_CHANGED"]);
    expect(result.facts[0]?.status).toBe("changed");
    expect(result.receipt.id).toBe("rcpt_1");
  });

  it("check() sends structured claims verbatim (the zero-LLM path) and omits undefined", async () => {
    let body: unknown;
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        body = JSON.parse(init?.body as string);
        return { json: { ...CHECK_RESULT, decision: "ALLOW" } };
      }),
    });
    const result = await kaval.check({
      claims: [
        {
          subject: "Aetna",
          predicate: "requires_prior_auth_for",
          object: "CPT 12345",
        },
        "The 2024 IBC is the current edition",
      ],
      mode: "fast",
      max_wait_ms: undefined,
    });
    expect(body).toEqual({
      claims: [
        {
          subject: "Aetna",
          predicate: "requires_prior_auth_for",
          object: "CPT 12345",
        },
        "The 2024 IBC is the current edition",
      ],
      mode: "fast",
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("check() refuses a body with neither action nor claims before any network call", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { json: CHECK_RESULT };
      }),
    });
    expect(() => kaval.check({ context: "no action" })).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("getReceipt() GETs the signed receipt and unwraps it", async () => {
    let seen: { url: string; method?: string } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, method: init?.method };
        return {
          json: {
            receipt: {
              id: "rcpt_1",
              decision: "BLOCK",
              signature: { algorithm: "Ed25519", key_id: "k1" },
            },
          },
        };
      }),
    });
    const receipt = await kaval.getReceipt("rcpt_1");
    expect(seen).toEqual({
      url: "https://api.usekaval.com/v1/receipts/rcpt_1",
      method: "GET",
    });
    expect(receipt.id).toBe("rcpt_1");
    expect(receipt.signature.algorithm).toBe("Ed25519");
  });

  it("addSource() registers an entity by name and returns what it resolved to", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return {
          status: 201,
          json: { source: SOURCE, created: true, resolved: [SOURCE] },
        };
      }),
    });
    const out = await kaval.addSource({
      kind: "entity",
      name: "Aetna",
      intent: "payer policy bulletins",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/sources");
    expect(seen?.body).toEqual({
      kind: "entity",
      name: "Aetna",
      intent: "payer policy bulletins",
    });
    expect(out.created).toBe(true);
    expect(out.resolved).toHaveLength(1);
  });

  it("addSource() surfaces the authority filter's working and any discovery failure", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 201,
        json: {
          source: SOURCE,
          created: true,
          resolved: [SOURCE],
          authority: [
            {
              url: "https://www.aetna.com/health-care-professionals/policies.html",
              outcome: "accepted",
              reason: "curated authority domain",
            },
            {
              url: "https://www.aetnabetterhealth.com/pa/bulletins",
              outcome: "ambiguous",
              reason: "real Aetna page, different product line",
            },
          ],
          discovery_error: "plan compilation timed out",
        },
      })),
    });
    const out: AddSourceResult = await kaval.addSource({
      kind: "entity",
      name: "Aetna",
    });
    // `ambiguous` is the only outcome a customer must act on, so it has to be reachable: a real
    // page of the real entity governing a different product line, which Kaval refuses to guess at.
    expect(out.authority?.map((decision) => decision.outcome)).toEqual([
      "accepted",
      "ambiguous",
    ]);
    expect(out.authority?.[1]?.url).toContain("aetnabetterhealth.com");
    expect(out.discovery_error).toBe("plan compilation timed out");
  });

  it("recompileSource() POSTs the recompile route and returns the queued job", async () => {
    let seen: { path: string; method?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = {
          path: new URL(url).pathname,
          method: init?.method,
          body: JSON.parse(init?.body as string),
        };
        return {
          status: 202,
          json: { source_id: "src_1", job_id: "job_7", created: true },
        };
      }),
    });
    const out = await kaval.recompileSource("src_1");
    expect(seen).toEqual({
      path: "/v1/sources/src_1/recompile",
      method: "POST",
      body: {},
    });
    expect(out.job_id).toBe("job_7");
    // False would mean an open job absorbed this request rather than a second one being queued.
    expect(out.created).toBe(true);
  });

  it("addSource() requires a locator or a name before any network call", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { json: {} };
      }),
    });
    expect(() => kaval.addSource({ kind: "url" })).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("listSources() GETs the registry and opts into inactive rows", async () => {
    const urls: string[] = [];
    const kaval = new Kaval({
      fetch: mockFetch((url) => {
        urls.push(url);
        return { json: { sources: [SOURCE] } };
      }),
    });
    await kaval.listSources();
    await kaval.listSources({ includeInactive: true });
    expect(urls).toEqual([
      "https://api.usekaval.com/v1/sources",
      "https://api.usekaval.com/v1/sources?include_inactive=true",
    ]);
  });

  it("source lifecycle methods use the exact routes and HTTP verbs", async () => {
    const seen: Array<{ path: string; method?: string }> = [];
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen.push({ path: new URL(url).pathname, method: init?.method });
        return { json: { source: SOURCE, deleted: true, id: "src_1" } };
      }),
    });
    await kaval.getSource("src_1");
    await kaval.pauseSource("src_1");
    await kaval.resumeSource("src_1");
    await kaval.deleteSource("src_1");
    expect(seen).toEqual([
      { path: "/v1/sources/src_1", method: "GET" },
      { path: "/v1/sources/src_1/pause", method: "POST" },
      { path: "/v1/sources/src_1/resume", method: "POST" },
      { path: "/v1/sources/src_1", method: "DELETE" },
    ]);
  });

  it("sendEvent() pushes a document and reports whether it actually changed", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) };
        return {
          json: {
            accepted: true,
            changed: true,
            source_id: "src_2",
            version_id: "ver_9",
            content_sha256: "a".repeat(64),
            previous_content_sha256: null,
            facts_pending_review: 3,
          },
        };
      }),
    });
    const out = await kaval.sendEvent({
      namespace: "matey",
      document_id: "msa-2026-07",
      content: "the amended agreement text",
      scope_keys: ["contract:msa-2026-07"],
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/events");
    expect(out.changed).toBe(true);
    expect(out.facts_pending_review).toBe(3);
  });

  it("subscribeFactStateDeltas() registers the fact_state family with an idempotency key", async () => {
    let seen:
      { url: string; method?: string; key?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = {
          url,
          method: init?.method,
          key: (init?.headers as Record<string, string>)["idempotency-key"],
          body: JSON.parse(init?.body as string),
        };
        return {
          status: 201,
          json: {
            subscription: { subscription_id: "sub_1" },
            webhook_verification: {
              algorithm: "hmac-sha256",
              key_id: "k1",
              secret: "s",
              signed_content: "id.timestamp.body",
              headers: ["webhook-signature"],
            },
          },
        };
      }),
    });
    const out = await kaval.subscribeFactStateDeltas(
      {
        callback_url: "https://example.com/hooks/kaval",
        external_scope_ids: ["contract:msa-2026-07"],
      },
      { idempotencyKey: "webhook-operation-0001" },
    );
    expect(seen?.url).toBe("https://api.usekaval.com/v1/webhooks");
    expect(seen?.method).toBe("POST");
    // POST /v1/webhooks refuses a request without a bounded Idempotency-Key header.
    expect(seen?.key).toBe("webhook-operation-0001");
    expect(seen?.body).toEqual({
      callback_url: "https://example.com/hooks/kaval",
      external_scope_ids: ["contract:msa-2026-07"],
      subscription_kind: "fact_state",
      event_types: ["fact_state.delta"],
    });
    expect(out.subscription.subscription_id).toBe("sub_1");
    expect(out.webhook_verification.secret).toBe("s");
  });

  it("createWebhook() generates an idempotency key when the caller supplies none", async () => {
    let key: string | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((_u, init) => {
        key = (init?.headers as Record<string, string>)["idempotency-key"];
        return { json: { subscription: {}, webhook_verification: {} } };
      }),
    });
    await kaval.createWebhook({
      subscription_kind: "fact_state",
      callback_url: "https://example.com/hooks/kaval",
      event_types: ["fact_state.delta"],
    });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("createWebhook() rejects a non-https callback URL before any network call", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { json: {} };
      }),
    });
    expect(() =>
      kaval.createWebhook({
        subscription_kind: "fact_state",
        callback_url: "http://example.com/hooks",
        event_types: ["fact_state.delta"],
      }),
    ).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("webhook lifecycle methods use the exact routes and HTTP verbs", async () => {
    const seen: Array<{ path: string; method?: string }> = [];
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen.push({ path: new URL(url).pathname, method: init?.method });
        return { json: { subscriptions: [], subscription_id: "sub_1" } };
      }),
    });
    await kaval.listWebhooks();
    await kaval.setWebhookEnabled("sub_1", false);
    await kaval.deleteWebhook("sub_1");
    await kaval.replayWebhookDelivery("del_1");
    expect(seen).toEqual([
      { path: "/v1/webhooks", method: "GET" },
      { path: "/v1/webhooks/sub_1", method: "PATCH" },
      { path: "/v1/webhooks/sub_1", method: "DELETE" },
      { path: "/v1/webhook-deliveries/del_1/replay", method: "POST" },
    ]);
  });

  it("listWebhookDeliveries() pages the log that publishes the replayable delivery id", async () => {
    const paths: string[] = [];
    const kaval = new Kaval({
      fetch: mockFetch((url) => {
        const parsed = new URL(url);
        paths.push(`${parsed.pathname}${parsed.search}`);
        return {
          json: {
            status: "ok",
            items: [
              {
                delivery_id: "d1e0f2a3-4b5c-4d6e-8f90-1a2b3c4d5e6f",
                subscription_id: "sub_1",
                state: "dead_letter",
                attempt: 5,
              },
            ],
            next_before: "2026-07-26T00:00:00.000Z",
          },
        };
      }),
    });
    const page = await kaval.listWebhookDeliveries("sub_1");
    await kaval.listWebhookDeliveries("sub_1", {
      before: "2026-07-26T00:00:00.000Z",
      limit: 100,
    });
    expect(paths).toEqual([
      "/v1/webhooks/sub_1/deliveries",
      "/v1/webhooks/sub_1/deliveries?before=2026-07-26T00%3A00%3A00.000Z&limit=100",
    ]);
    // Nothing else in the API hands out a delivery id, so replay is unreachable without this.
    expect(page.items[0]?.delivery_id).toBe(
      "d1e0f2a3-4b5c-4d6e-8f90-1a2b3c4d5e6f",
    );
    expect(page.next_before).toBe("2026-07-26T00:00:00.000Z");
  });

  it("rotateWebhookSigningKey() sends the overlap window and returns the new secret", async () => {
    let seen: { path: string; method?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = {
          path: new URL(url).pathname,
          method: init?.method,
          body: JSON.parse(init?.body as string),
        };
        return {
          json: {
            rotation: {
              subscription_id: "sub_1",
              signing_key_id: "k2",
              previous_signing_key_id: "k1",
              previous_key_expires_at: "2026-07-28T00:00:00.000Z",
            },
            webhook_verification: { key_id: "k2", secret: "s2" },
          },
        };
      }),
    });
    const out = await kaval.rotateWebhookSigningKey("sub_1", {
      overlap_until: "2026-07-28T00:00:00.000Z",
    });
    expect(seen).toEqual({
      path: "/v1/webhooks/sub_1/rotate",
      method: "POST",
      body: { overlap_until: "2026-07-28T00:00:00.000Z" },
    });
    // The overlap window is what lets a receiver accept both generations while it redeploys.
    expect(out.rotation.previous_key_expires_at).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(out.webhook_verification.secret).toBe("s2");
  });

  it("rotateWebhookSigningKey() refuses a missing overlap window before any network call", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { json: {} };
      }),
    });
    expect(() =>
      kaval.rotateWebhookSigningKey("sub_1", {
        overlap_until: "" as never,
      }),
    ).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("reportOutcome() posts to /v1/report-outcome without an idempotency key", async () => {
    let seen:
      { url: string; idempotencyKey?: string; body: unknown } | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((url, init) => {
        seen = {
          url,
          idempotencyKey: (init?.headers as Record<string, string>)?.[
            "idempotency-key"
          ],
          body: JSON.parse(init?.body as string),
        };
        return { json: { ok: true } };
      }),
    });
    const out = await kaval.reportOutcome({
      id: "rcpt_1",
      kind: "relied_and_correct",
    });
    expect(seen?.url).toBe("https://api.usekaval.com/v1/report-outcome");
    expect(seen?.idempotencyKey).toBeUndefined();
    expect(seen?.body).toEqual({ id: "rcpt_1", kind: "relied_and_correct" });
    expect(out.ok).toBe(true);
  });

  it("respects a custom baseUrl and trims the trailing slash", async () => {
    let url: string | undefined;
    const kaval = new Kaval({
      baseUrl: "http://localhost:8787/",
      fetch: mockFetch((u) => {
        url = u;
        return { json: CHECK_RESULT };
      }),
    });
    await kaval.check({ action: "x" });
    expect(url).toBe("http://localhost:8787/v1/check");
  });

  it("throws KavalError on a non-2xx response", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 402,
        json: { error: { code: "subscription_required" } },
      })),
    });
    await expect(kaval.check({ action: "x" })).rejects.toBeInstanceOf(
      KavalError,
    );
  });

  it("turns a 410 tool_retired into a KavalRetiredError that names check()", async () => {
    const retired = (async () =>
      new Response(
        JSON.stringify({ error: "tool_retired", replacement: "/v1/check" }),
        { status: 410, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    // Both transports (billable and plain) must recognise the flat retired body.
    const error = await new Kaval({ fetch: retired })
      .verify({
        conclusion: "x",
        evidence_refs: ["https://example.com/source"],
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(KavalRetiredError);
    expect((error as KavalRetiredError).replacement).toBe("/v1/check");
    expect((error as KavalRetiredError).message).toContain("check()");

    const readError = await new Kaval({ fetch: retired })
      .check({ action: "x" })
      .catch((value: unknown) => value);
    expect(readError).toBeInstanceOf(KavalRetiredError);
  });

  it("does not retry a terminal API response", async () => {
    let calls = 0;
    const kaval = new Kaval({
      fetch: mockFetch(() => {
        calls += 1;
        return { status: 503, json: { error: { code: "unavailable" } } };
      }),
    });

    await expect(kaval.check({ action: "x" })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toBe(1);
  });

  it("keeps the default deadline above the server's own research budget", async () => {
    /*
     * The quickstart's first call is a COLD check: nothing is watched yet, so every fact goes to
     * live research, which the server budgets at 100s by default behind a 150s handler deadline.
     * A 30s client deadline meant the copy-paste path aborted the product's headline call every
     * time — a client deadline under the server's does not bound anything, it just guarantees an
     * AbortError instead of a verdict.
     */
    vi.useFakeTimers();
    try {
      const pending = new Kaval({ fetch: hangingFetch() }).check({
        action: "Issue Acme a $12,000 refund",
      });
      let outcome: unknown = "pending";
      void pending.catch((error: unknown) => {
        outcome = error;
      });

      await vi.advanceTimersByTimeAsync(MAX_CHECK_MAX_WAIT_MS);
      expect(outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(50_000);
      expect(outcome).toMatchObject({
        message: "kaval request timed out after 150000ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a per-call timeout to a check", async () => {
    let calls = 0;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const pending = new Kaval({ fetch: fetchImpl }).check(
      { action: "x" },
      { timeoutMs: 5 },
    );
    await expect(pending).rejects.toMatchObject({
      message: "kaval request timed out after 5ms",
    });
    expect(calls).toBe(1);
  });

  it("cancels a check immediately when the caller aborts", async () => {
    let calls = 0;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = new Kaval({ fetch: fetchImpl, timeoutMs: null }).check(
      { action: "x" },
      { signal: controller.signal },
    );
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toMatchObject({
      message: "caller cancelled",
    });
    expect(calls).toBe(1);
  });

  it("health() GETs /health and returns the status", async () => {
    let url: string | undefined;
    const kaval = new Kaval({
      fetch: mockFetch((u) => {
        url = u;
        return { json: { ok: true, name: "kaval", version: "0.6.0" } };
      }),
    });
    const out = await kaval.health();
    expect(url).toBe("https://api.usekaval.com/health");
    expect(out.ok).toBe(true);
    expect(out.name).toBe("kaval");
  });

  it("health() honours timeoutMs and cancellation like every other method", async () => {
    // The README states the `{ signal, timeoutMs }` contract as universal. health() used to call
    // fetch directly with no signal at all, so the one call whose whole job is "is it up?" was
    // also the one call that could hang forever.
    const timedOut = new Kaval({ fetch: hangingFetch() }).health({
      timeoutMs: 5,
    });
    await expect(timedOut).rejects.toMatchObject({
      message: "kaval request timed out after 5ms",
    });

    const controller = new AbortController();
    const cancelled = new Kaval({
      fetch: hangingFetch(),
      timeoutMs: null,
    }).health({ signal: controller.signal });
    controller.abort(new Error("caller cancelled"));
    await expect(cancelled).rejects.toMatchObject({
      message: "caller cancelled",
    });
  });

  it("health() throws KavalError on a non-2xx response", async () => {
    const kaval = new Kaval({
      fetch: mockFetch(() => ({
        status: 503,
        json: { error: { code: "unavailable" } },
      })),
    });
    await expect(kaval.health()).rejects.toBeInstanceOf(KavalError);
  });

  it("no longer exposes any retired method", () => {
    const kaval = new Kaval() as unknown as Record<string, unknown>;
    for (const retired of [
      "audit",
      "gate",
      "gateAction",
      "verifyBelief",
      "extractAndCheck",
      "scanStore",
      "monitor",
      "kaval",
      "kavalBatch",
    ]) {
      expect(kaval[retired], `${retired} must be gone`).toBeUndefined();
    }
  });
});

/**
 * The receipt is the artifact a holder re-derives OFFLINE, so a field the server signs and this
 * package does not type is a field nobody outside Kaval can use.
 */
describe("receipt basis contract", () => {
  /*
   * Exhaustive by construction: `Record<keyof Required<CheckReceiptBasis>, true>` makes a missing
   * key AND an unknown key a compile error, so this list cannot drift from the interface it stands
   * in for. Together with the recorded receipt below that closes the loop in both directions — a
   * field the server emits must be in the type, and the type cannot claim fields it made up.
   */
  const BASIS_KEYS: Record<keyof Required<CheckReceiptBasis>, true> = {
    source_locator: true,
    version_sha256: true,
    version_sha256_of: true,
    parser_name: true,
    parser_version: true,
    fetched_at: true,
    publication_time: true,
    span_ref: true,
  };

  it("types every basis key the server actually signs", () => {
    const emitted = new Set<string>();
    for (const fact of RECORDED_RECEIPT.facts) {
      for (const basis of fact.basis) {
        for (const key of Object.keys(basis)) emitted.add(key);
      }
    }
    // Guard the guard: an empty or basis-free recording would make this test vacuously green.
    expect([...emitted]).toEqual(
      expect.arrayContaining(["source_locator", "version_sha256"]),
    );
    for (const key of emitted) {
      expect(BASIS_KEYS, `basis.${key} is signed but untyped`).toHaveProperty(
        key,
      );
    }
  });

  it("carries the discriminator that makes version_sha256 re-derivable", () => {
    const basis = RECORDED_RECEIPT.facts
      .flatMap((fact) => fact.basis)
      .filter((entry) => entry.version_sha256 !== undefined);
    expect(basis.length).toBeGreaterThan(0);
    // A PDF's canonical text and its raw bytes are two unequal legitimate digests of one document.
    // Unlabelled, a holder cannot know which artifact to hash and the digest is decorative.
    for (const entry of basis) {
      expect(["canonical_text", "raw_bytes"]).toContain(
        entry.version_sha256_of,
      );
    }
    const extracted = basis.find(
      (entry) => entry.version_sha256_of === "canonical_text",
    );
    expect(extracted?.parser_name).toBe("reducto");
    expect(extracted?.parser_version).toBe("v2+opts.0123456789ab");
  });
});

/**
 * `max_wait_ms` shipped for a long time as "defaults to 3000, max 15000" — a warm-path latency
 * target published for a cold path the engine had already rebudgeted to 100000. The private repo
 * guards that string on the docs site; this is the same guard on the package customers install.
 */
describe("published research budget", () => {
  const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("exports the server's three numbers rather than making callers type them", () => {
    expect(MIN_CHECK_MAX_WAIT_MS).toBe(0);
    expect(DEFAULT_CHECK_MAX_WAIT_MS).toBe(100_000);
    // Equal to the default on purpose: the budget exists to ask for less waiting, never more.
    expect(MAX_CHECK_MAX_WAIT_MS).toBe(DEFAULT_CHECK_MAX_WAIT_MS);
  });

  it("does not republish the abandoned budget anywhere a caller can copy it", () => {
    const stale = [/defaults? to 3000\b/i, /default 3000\b/i, /max 15000\b/i];
    const sources = {
      "README.md": README,
      "src/check.ts": readFileSync(
        new URL("../src/check.ts", import.meta.url),
        "utf8",
      ),
      "src/index.ts": readFileSync(
        new URL("../src/index.ts", import.meta.url),
        "utf8",
      ),
    };
    for (const [name, text] of Object.entries(sources)) {
      for (const pattern of stale) {
        expect(pattern.test(text), `${name} republishes ${pattern}`).toBe(
          false,
        );
      }
    }
    expect(README).toContain(`default ${DEFAULT_CHECK_MAX_WAIT_MS}`);
    expect(README).toContain(`max ${MAX_CHECK_MAX_WAIT_MS}`);
  });
});
