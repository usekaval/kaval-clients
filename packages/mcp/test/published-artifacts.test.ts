/**
 * Conformance/smoke against npm-packed `@usekaval/kaval` + `@usekaval/mcp` — what registry consumers resolve,
 * not the pnpm workspace symlink.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fakeAddSourceResult,
  fakeCheckReceipt,
  fakeCheckResult,
  fakeKavalFetch,
  fakeReceiptId,
  fakeVerifyReceipt,
  fakeVerifyRequest,
  parseToolText,
} from "./helpers/fake-api.js";
import {
  installPackedTarballs,
  isWorkspaceLinkedPackage,
  type PackedInstall,
} from "./helpers/pack-and-install.js";

const kavalWorkspaceDir = fileURLToPath(
  new URL("../../../sdks/node", import.meta.url),
);
const mcpWorkspaceDir = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

const EXPECTED_TOOLS = [
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
  "list_publishers",
  "create_publisher",
  "add_source",
  "list_sources",
  "remove_source",
  "update_source",
  "get_source_version_content",
  "report_outcome",
  "verify",
] as const;

const EXPECTED_RESOURCES = [
  "kaval://bulletins",
  "kaval://bulletins/extraction-attempts",
  "kaval://training-jobs",
  "kaval://training-feedback",
] as const;
const EXPECTED_RESOURCE_TEMPLATES = [
  "kaval://contracts/{contract_id}",
  "kaval://contracts/{contract_id}/claims",
  "kaval://contracts/{contract_id}/extraction-issues",
  "kaval://bulletins/{source_version_id}",
  "kaval://bulletins/extraction-attempts/{source_version_id}",
  "kaval://fact-imports/{import_id}",
  "kaval://training-jobs/{job_id}",
] as const;

describe("published tarballs (not workspace-linked kaval)", () => {
  let install: PackedInstall;

  beforeAll(async () => {
    install = await installPackedTarballs();
  }, 120_000);

  afterAll(() => {
    install?.cleanup();
  });

  it("installs kaval from the packed tarball, not the workspace link", () => {
    expect(
      isWorkspaceLinkedPackage(install.kavalRealPath, kavalWorkspaceDir),
    ).toBe(false);
    expect(isWorkspaceLinkedPackage(install.mcpRealPath, mcpWorkspaceDir)).toBe(
      false,
    );
  });

  it("packs only the supported release surface with consistent versions", () => {
    expect(install.kavalVersion).toBe(install.mcpVersion);
    expect(install.mcpKavalDependency).toBe(`^${install.kavalVersion}`);
    expect(install.kavalTarEntries).toEqual(
      expect.arrayContaining([
        "package/package.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/portfolio.js",
        "package/dist/portfolio.d.ts",
        "package/dist/verify/decision.js",
        "package/dist/verify/decision.d.ts",
      ]),
    );
    expect(install.mcpTarEntries).toEqual(
      expect.arrayContaining([
        "package/package.json",
        "package/dist/index.js",
        "package/dist/server.js",
        "package/dist/bin.js",
      ]),
    );
    for (const entry of [
      ...install.kavalTarEntries,
      ...install.mcpTarEntries,
    ]) {
      expect(entry).not.toMatch(/^package\/(?:src|test)\//u);
      expect(entry).not.toMatch(/\.tsbuildinfo$/u);
    }
  });

  it("loads the complete SDK surface from the fresh installation", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("@usekaval/kaval");
    const client = new Kaval({
      apiKey: "kv_live_test",
      baseUrl: "http://127.0.0.1:1",
    });
    for (const method of [
      "check",
      "getReceipt",
      "createContractUpload",
      "createContract",
      "getContract",
      "listContractClaims",
      "listContractExtractionIssues",
      "reviewContractClaim",
      "createFactImport",
      "getFactImport",
      "listBulletins",
      "getBulletin",
      "listBulletinExtractionAttempts",
      "getBulletinExtractionAttempt",
      "listTrainingJobs",
      "getTrainingJob",
      "listTrainingFeedback",
      "recordTrainingFeedbackConsent",
    ] as const) {
      expect(typeof client[method], method).toBe("function");
    }
  });

  it("runs a portfolio workflow through the fresh SDK installation", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("@usekaval/kaval");
    const requests: Array<{
      path: string;
      method: string;
      key: string | null;
    }> = [];
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
        path: `${url.pathname}${url.search}`,
        method,
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      const payload =
        url.pathname === "/v1/contract-uploads"
          ? { id: "10000000-0000-4000-8000-000000000001" }
          : url.pathname === "/v1/contracts"
            ? { id: "20000000-0000-4000-8000-000000000001", state: "queued" }
            : { bulletins: [], next_cursor: null };
      return new Response(JSON.stringify(payload), {
        status: method === "POST" ? 202 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = new Kaval({ apiKey: "kv_live_test", fetch });

    await client.createContractUpload(
      {
        filename: "agreement.pdf",
        content_type: "application/pdf",
        size_bytes: 128,
        sha256: "a".repeat(64),
      },
      { idempotencyKey: "packed-upload-001" },
    );
    await client.createContract(
      {
        external_id: "agreement-001",
        title: "Signed agreement",
        document_type: "base_agreement",
        authority_status: "signed",
        contract_family_key: "payer-hospital-001",
        effective_from: "2026-01-01",
        effective_to: null,
        supersedes_contract_id: null,
        source: { kind: "canonical_text", content: "Filing limit: 120 days." },
      },
      { idempotencyKey: "packed-contract-001" },
    );
    await client.listBulletins({ payerId: "payer-001", limit: 100 });
    expect(() => client.listBulletins({ limit: 101 })).toThrow(
      /1 through 100/u,
    );

    expect(requests).toEqual([
      {
        path: "/v1/contract-uploads",
        method: "POST",
        key: "packed-upload-001",
      },
      {
        path: "/v1/contracts",
        method: "POST",
        key: "packed-contract-001",
      },
      {
        path: "/v1/bulletins?payer_id=payer-001&limit=100",
        method: "GET",
        key: null,
      },
    ]);
  });

  it("starts the packed MCP bin and lists its exact tools and resources over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [install.mcpBin],
      env: { PATH: process.env.PATH ?? "", KAVAL_API_KEY: "kv_live_test" },
    });
    const client = new McpClient({
      name: "published-bin-smoke",
      version: "0.0.0",
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(EXPECTED_TOOLS);
      expect(names.join(" ")).not.toMatch(/offer|product/);
      expect(names).not.toContain("promote_model");
      const bulletin = tools.find((tool) => tool.name === "list_bulletins");
      const bulletinSchema = bulletin?.inputSchema as {
        properties?: { limit?: { maximum?: number } };
      };
      expect(bulletinSchema.properties?.limit?.maximum).toBe(100);
      expect(
        (await client.listResources()).resources.map(
          (resource) => resource.uri,
        ),
      ).toEqual(EXPECTED_RESOURCES);
      expect(
        (await client.listResourceTemplates()).resourceTemplates.map(
          (resource) => resource.uriTemplate,
        ),
      ).toEqual(EXPECTED_RESOURCE_TEMPLATES);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("verifies and re-derives a signed rule-2 receipt offline from the fresh SDK", async () => {
    const decisionVectors = JSON.parse(
      readFileSync(
        new URL(
          "../../../sdks/node/test/fixtures/verify-vectors/check-decision-v2-vectors.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      base_receipt: Record<string, unknown>;
      signed_receipts: Array<{ signature_base64url: string }>;
    };
    const signatureVectors = JSON.parse(
      readFileSync(
        new URL(
          "../../../sdks/node/test/fixtures/verify-vectors/ed25519-receipt-vectors.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { keyset: Record<string, unknown> };
    const checkedAt = decisionVectors.base_receipt["checked_at"];
    const receipt = {
      ...decisionVectors.base_receipt,
      signature: {
        algorithm: "Ed25519",
        key_id: "vector-ed25519-001",
        signature: decisionVectors.signed_receipts[0]!.signature_base64url,
        signed_at: checkedAt,
      },
    };
    const receiptPath = join(install.root, "receipt.json");
    const keysetPath = join(install.root, "keyset.json");
    const denialPath = join(install.root, "deny-network.mjs");
    const driverPath = join(install.root, "verify-offline.mjs");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(keysetPath, JSON.stringify(signatureVectors.keyset));
    writeFileSync(
      denialPath,
      `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const attempts = [];
const deny = (name) => function denied() {
  attempts.push(name);
  throw new Error("network denied: " + name);
};
globalThis.__kavalNetworkAttempts = attempts;
globalThis.fetch = deny("fetch");
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
net.Socket.prototype.connect = deny("socket");
net.connect = deny("socket");
tls.connect = deny("tls");
http.request = deny("http.request");
http.get = deny("http.get");
https.request = deny("https.request");
https.get = deny("https.get");
dns.lookup = deny("dns.lookup");
dnsPromises.lookup = deny("dns.lookup");
`,
    );
    writeFileSync(
      driverPath,
      `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveCheckDecision, verifyReceipt } from "@usekaval/kaval/verify";
assert.throws(() => globalThis.fetch("https://network-control.invalid"), /network denied: fetch/);
assert.deepEqual(globalThis.__kavalNetworkAttempts, ["fetch"]);
globalThis.__kavalNetworkAttempts.length = 0;
const receipt = JSON.parse(await readFile(new URL("./receipt.json", import.meta.url), "utf8"));
const keyset = JSON.parse(await readFile(new URL("./keyset.json", import.meta.url), "utf8"));
const result = verifyReceipt(receipt, keyset, { derive_verdict: true });
assert.equal(result.cryptographic.valid, true);
assert.equal(result.decision.matches, true);
assert.equal(result.decision.derived.verdict, "ALLOW");
assert.equal(deriveCheckDecision(receipt).verdict, "ALLOW");
assert.equal(result.accepted, true);
assert.deepEqual(globalThis.__kavalNetworkAttempts, []);
console.log(JSON.stringify({ accepted: result.accepted, verdict: result.decision.derived.verdict }));
`,
    );

    const library = await execute(
      process.execPath,
      ["--import", denialPath, driverPath],
      { cwd: install.root },
    );
    expect(JSON.parse(library.stdout.trim())).toEqual({
      accepted: true,
      verdict: "ALLOW",
    });

    const cli = await execute(
      process.execPath,
      [
        "--import",
        denialPath,
        install.receiptVerifyBin,
        "verify",
        receiptPath,
        "--keyset",
        keysetPath,
        "--derive-verdict",
        "--compact",
      ],
      { cwd: install.root },
    );
    const cliResult = JSON.parse(cli.stdout.trim()) as {
      accepted: boolean;
      decision?: { matches?: boolean; derived?: { verdict?: string } };
    };
    expect(cliResult.accepted).toBe(true);
    expect(cliResult.decision?.matches).toBe(true);
    expect(cliResult.decision?.derived?.verdict).toBe("ALLOW");
  }, 30_000);

  it("conformance: packed kaval + MCP server expose check, the source registry, and the verify alias", async () => {
    const { Kaval } = (await import(
      install.kavalEntry
    )) as typeof import("@usekaval/kaval");
    const { createMcpServer } = (await import(
      install.mcpServerEntry
    )) as typeof import("../src/server.js");

    const kaval = new Kaval({ apiKey: "kv_live_test", fetch: fakeKavalFetch });
    const server = createMcpServer(kaval);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new McpClient({
      name: "published-conformance",
      version: "0.0.0",
    });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const checkResult = await client.callTool({
      name: "check",
      arguments: {
        action:
          "Approve this prior-authorization request at the in-network rate",
        context: "payer: Aetna; CPT 12345",
      },
    });
    const check = parseToolText(checkResult);
    expect(check).toEqual(fakeCheckResult);
    expect(check.decision).toBe("BLOCK");
    expect(check.receipt?.id).toBe(fakeReceiptId);

    // get_receipt calls straight through to the packed client's getReceipt — a method the MCP
    // surface now depends on, so a tarball published without it must fail here.
    const receiptResult = await client.callTool({
      name: "get_receipt",
      arguments: { receipt_id: check.receipt!.id! },
    });
    expect(parseToolText(receiptResult).receipt).toEqual(fakeCheckReceipt);

    const sourceResult = await client.callTool({
      name: "add_source",
      arguments: {
        publisher_id: "7c3e1a90-2b4d-4f18-9e6c-8a1b0d5e4f22",
        kind: "entity",
        name: "Aetna",
        intent: "payer policy bulletins",
      },
    });
    expect(parseToolText(sourceResult)).toEqual(fakeAddSourceResult);

    const listResult = await client.callTool({
      name: "list_sources",
      arguments: {},
    });
    expect(parseToolText(listResult).sources).toHaveLength(1);

    const verifyResult = await client.callTool({
      name: "verify",
      arguments: fakeVerifyRequest,
    });
    const verify = parseToolText(verifyResult);
    expect(verify).toEqual(fakeVerifyReceipt);
    expect(verify.receipt?.packet?.signature?.algorithm).toBe("Ed25519");
  });
});
