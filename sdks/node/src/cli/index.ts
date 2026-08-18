#!/usr/bin/env node

/**
 * `kaval` — the terminal surface.
 *
 * A thin renderer over the SDK in this same package, which is the point: every field it prints came
 * off a real response, and the wire types cannot drift from the ones the SDK already publishes
 * because they are the same types. It invents nothing. If the server did not say it, this does not
 * print it — including the failures. A CLI that can only show a good day is a fixture with a
 * network call in it.
 *
 * Exit codes make `kaval check` usable as a shell gate:
 *
 *   0  ALLOW      1  usage, transport or auth failure
 *   2  REVIEW     3  BLOCK
 *
 * The API key comes from `KAVAL_API_KEY` and nowhere else — never a flag. A key on the command line
 * lands in shell history and in `ps` output for every other user on the box.
 */

import process from "node:process";
import { Kaval, KavalError } from "../index.js";
import type {
  AuthorityDecision,
  CheckResult,
  PortfolioExposure,
  WatchedSource,
  WatchedSourcePlan,
} from "../check.js";

const HELP = `Usage:
  kaval sources add <name-or-url> --publisher-id <uuid> [--intent <text>] [--kind entity|url]
  kaval sources ls [--all]
  kaval sources plan <source-id>
  kaval check "<action>" [--origin <url>]... [--fast]
  kaval exposure [--limit <n>]
  kaval receipt <receipt-id>

Environment:
  KAVAL_API_KEY    required — an issued kv_live_ key
  KAVAL_API_BASE   optional — defaults to https://api.usekaval.com

Options:
  --publisher-id   org publisher UUID (required for sources add)
  --json           emit the raw response instead of the rendered view
  -h, --help       show this help

Exit status: 0 ALLOW · 2 REVIEW · 3 BLOCK · 1 usage/transport/auth.
`;

/* --------------------------------- rendering --------------------------------- */

const tty =
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const c = (code: string) => (text: string) =>
  tty ? `[${code}m${text}[0m` : text;
const dim = c("38;5;245");
const faint = c("38;5;240");
const ink = c("38;5;252");
const bold = c("1");
const green = c("38;5;71");
const red = c("38;5;167");
const amber = c("38;5;179");
const mag = c("38;5;140");

/** The verdict chip. Background-filled so it reads at a glance in a recording. */
function verdictChip(verdict: string): string {
  if (!tty) return verdict;
  const background =
    verdict === "ALLOW"
      ? "48;5;71"
      : verdict === "BLOCK"
        ? "48;5;167"
        : "48;5;179";
  return `[${background};38;5;235;1m ${verdict} [0m`;
}

const out = (line = "") => process.stdout.write(`${line}\n`);

/**
 * The decision log, rendered by what a reader can act on.
 *
 * When a reviewed catalog row names the entity's surfaces, search still runs and its candidates
 * still pass through the authority filter — that is what keeps a lookalike's discard visible. But
 * "accepted, and not watched, because a human already said which address" is not a decision anyone
 * needs to read one line at a time. Against a live search for Aetna that is ten near-identical
 * lines burying the one that matters. They are counted, not hidden, and never dropped from --json.
 */
function renderAuthority(
  decisions: readonly AuthorityDecision[] | undefined,
  watched: ReadonlySet<string>,
): void {
  let acceptedNotWatched = 0;
  for (const decision of decisions ?? []) {
    if (decision.outcome === "accepted" && !watched.has(decision.url)) {
      acceptedNotWatched += 1;
      continue;
    }
    const mark =
      decision.outcome === "accepted"
        ? green("✓")
        : decision.outcome === "ambiguous"
          ? amber("?")
          : red("✗");
    const { host, path } = splitUrl(decision.url);
    out(`  ${mark} ${host}${dim(path)}`);
    // The filter's OWN reason string, verbatim. Paraphrasing it here would mean the terminal and the
    // API disagree about why a source was dropped.
    if (decision.reason) out(`    ${faint(decision.reason)}`);
    if (decision.outcome === "ambiguous") {
      out(
        `    ${amber("needs a decision — narrow it with --intent or a scope key")}`,
      );
    }
  }
  if (acceptedNotWatched > 0) {
    out(
      `  ${faint(`+ ${acceptedNotWatched} more on the same domain passed the filter — a reviewed plan names the surface`)}`,
    );
  }
}

function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: url, path: "" };
  }
}

/* ---------------------------------- commands --------------------------------- */

async function sourcesAdd(
  kaval: Kaval,
  rest: string[],
  flags: Flags,
): Promise<number> {
  const target = rest[0];
  if (target === undefined) return usage("sources add needs a name or URL");
  const kind =
    flags.kind === "url" || flags.kind === "entity"
      ? flags.kind
      : /^https?:\/\//u.test(target)
        ? "url"
        : "entity";

  if (flags.publisherId === undefined) {
    return usage("sources add needs --publisher-id <uuid>");
  }
  const result = await kaval.addSource({
    kind,
    publisher_id: flags.publisherId,
    ...(kind === "entity" ? { name: target } : { locator: target }),
    ...(flags.intent === undefined ? {} : { intent: flags.intent }),
  });
  if (flags.json) return json(result);

  const watchedUrls = new Set(result.resolved.map((source) => source.locator));
  out();
  renderAuthority(result.authority, watchedUrls);
  // A resolution that produced nothing is the interesting case, and it is reported rather than
  // rendered as an empty success.
  if (result.resolution_error) {
    out(`  ${red("✗")} ${ink(result.resolution_error)}`);
  }
  if (result.discovery_error) {
    out(`  ${amber("!")} ${ink(`plan discovery: ${result.discovery_error}`)}`);
  }
  out();
  const watched =
    result.resolved.length > 0 ? result.resolved : [result.source];
  for (const source of watched) {
    out(`  ${dim("watching")}  ${ink(source.label ?? source.locator)}`);
    out(`            ${faint(source.id)}`);
  }
  out();
  return 0;
}

async function sourcesList(kaval: Kaval, flags: Flags): Promise<number> {
  const sources = await kaval.listSources(
    flags.all ? { includeInactive: true } : {},
  );
  if (flags.json) return json({ sources });
  out();
  if (sources.length === 0) {
    out(
      `  ${dim("no watched sources yet — try")} ${ink('kaval sources add "Aetna"')}`,
    );
    out();
    return 0;
  }
  for (const source of sources as Array<
    WatchedSource & { current_plan_id?: string | null }
  >) {
    const planned = source.current_plan_id
      ? green("planned")
      : faint("no plan");
    out(
      `  ${ink(source.label ?? source.locator)}  ${dim(source.kind)}  ${planned}`,
    );
    out(`    ${faint(source.id)}  ${faint(source.locator)}`);
  }
  out();
  return 0;
}

async function sourcesPlan(
  kaval: Kaval,
  rest: string[],
  flags: Flags,
): Promise<number> {
  const id = rest[0];
  if (id === undefined) return usage("sources plan needs a source id");
  const view = await kaval.getSourcePlan(id);
  if (flags.json) return json(view);

  out();
  if (view.plan === null) {
    // "Not yet" and "never will be" are different, and the job below is what distinguishes them.
    out(`  ${faint("no acquisition plan yet")}`);
  } else {
    const probation = view.plan.last_validated_at === null;
    out(
      `  ${green("✓")} ${bold(`tier ${view.plan.tier}`)} ${dim(`· ${view.plan.origin}`)}` +
        (probation
          ? ` ${faint("· on probation until its first successful poll")}`
          : ""),
    );
    out(
      `    ${faint(view.plan.steps.map((step: { kind: string }) => step.kind).join(" → "))}`,
    );
    if (view.plan.items_in_scope !== null) {
      out(
        `  ${dim("in scope")}  ${bold(view.plan.items_in_scope.toLocaleString())} ${dim("documents")}`,
      );
    }
  }
  if (view.discovery !== null) {
    // READ, never asserted. This is the only honest way to print "0 model calls".
    const spend = view.discovery.cost_usd;
    const spendText =
      spend === null
        ? ""
        : Number(spend) === 0
          ? " · 0 model calls"
          : ` · $${spend}`;
    out(`  ${dim("discovery")}  ${view.discovery.status}${dim(spendText)}`);
    if (view.discovery.error) out(`    ${red(view.discovery.error)}`);
  }
  out();
  return 0;
}

async function check(
  kaval: Kaval,
  rest: string[],
  flags: Flags,
): Promise<number> {
  const action = rest.join(" ").trim();
  if (action === "") return usage("check needs an action");

  const result: CheckResult = await kaval.check({
    action,
    // The documents the caller already read. An agent closing a claim knows which bulletin it
    // relied on, and saying so is the difference between research reading THAT page and research
    // going looking: an action naming no document compiled into sound premises and then bound them
    // to the Social Security Administration's policy manual, because "underpayment review" and
    // "denial upheld" are words that live there too.
    ...(flags.origins.length === 0 ? {} : { origin_urls: flags.origins }),
    ...(flags.fast === true ? { mode: "fast" as const } : {}),
  });
  if (flags.json) return json(result);

  const facts = result.facts ?? [];
  const warm = facts.filter((fact) => fact.served_from_state).length;
  out();
  out(
    `  ${verdictChip(result.decision)}  ${dim(result.reason_codes[0] ?? "")}   ` +
      `${dim(`${facts.length} facts · ${warm} from state`)}` +
      ` · ${bold(`${result.latency_ms.total}ms`)}`,
  );
  if (facts.length > 0 && warm === facts.length) {
    out(`  ${faint("no fetch, no model call — answered from stored state")}`);
  }
  out();
  for (const fact of facts) {
    const changed = fact.status === "changed";
    const dot = changed
      ? red("●")
      : fact.status === "holds"
        ? green("●")
        : amber("●");
    const label = changed
      ? red("changed")
      : fact.status === "holds"
        ? green("holds  ")
        : amber(fact.status.padEnd(7));
    out(`  ${dot} ${label}  ${ink(fact.text)}`);
    const source = fact.sources[0];
    if (source) {
      const { host, path } = splitUrl(source.locator);
      const name = host === source.locator ? source.locator : `${host}${path}`;
      // The digest only when there IS one, and only truncated the way a person reads it.
      const digest = source.version_sha256
        ? `  ${source.version_sha256.slice(0, 16)}…`
        : "";
      out(`             ${faint(`${name}${digest}`)}`);
    }
  }
  out();
  out(
    `  ${dim("receipt")}  ${mag(result.receipt.id)}  ${faint("ed25519 · signed")}`,
  );
  out();
  return result.decision === "ALLOW" ? 0 : result.decision === "BLOCK" ? 3 : 2;
}

async function exposure(kaval: Kaval, flags: Flags): Promise<number> {
  const limit = Number(flags.limit);
  const view = await kaval.getExposure(Number.isFinite(limit) ? { limit } : {});
  if (flags.json) return json(view);

  out();
  if (view.total_conclusions === 0) {
    out(`  ${green("nothing is resting on language that has moved.")}`);
    out();
    return 0;
  }
  out(
    `  ${bold(String(view.total_conclusions))} ${ink("conclusions rest on language that has moved.")}`,
  );
  out();
  const pad = (value: string, width: number) => value.padEnd(width);
  const rt = (value: string | number, width: number) =>
    String(value).padStart(width);
  out(
    `    ${dim(pad("SOURCE", 34) + pad("MOVED", 12) + rt("CONCLUSIONS", 12))}`,
  );
  for (const row of view.sources) {
    const name = (row.label ?? row.locator).slice(0, 33);
    // An inferred date is marked, not laundered: `~` means "it changed, we do not know when".
    const moved =
      row.moved_at === null
        ? "—"
        : `${row.moved_at_is_recorded_change ? "" : "~"}${row.moved_at.slice(0, 10)}`;
    out(
      `  ${red("●")} ${ink(pad(name, 34))}${dim(pad(moved, 12))}${ink(rt(row.conclusions, 12))}`,
    );
  }
  out(`    ${faint("─".repeat(58))}`);
  out(
    `    ${pad("", 34)}${pad("", 12)}${bold(rt(view.total_conclusions, 12))}`,
  );
  if (view.truncated) {
    out(
      `    ${faint(`showing ${view.sources.length} of ${view.total_sources} sources`)}`,
    );
  }
  out();
  return 0;
}

async function receipt(kaval: Kaval, rest: string[]): Promise<number> {
  const id = rest[0];
  if (id === undefined) return usage("receipt needs a receipt id");
  // Always raw: a receipt is a document to be piped into a verifier, not a view.
  return json(await kaval.getReceipt(id));
}

/* ----------------------------------- plumbing ---------------------------------- */

interface Flags {
  json: boolean;
  all: boolean;
  fast: boolean;
  origins: string[];
  intent?: string;
  kind?: string;
  limit?: string;
  publisherId?: string;
}

/** Pull the API's `{error: {code, message}}` out without inventing a shape it might not have. */
function describePayload(payload: unknown): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (error !== null && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" || typeof message === "string") {
      return [code, message]
        .filter((part) => typeof part === "string")
        .join(" — ");
    }
  }
  return JSON.stringify(payload);
}

function json(value: unknown): number {
  out(JSON.stringify(value, null, 2));
  return 0;
}

function usage(message: string): number {
  process.stderr.write(`kaval: ${message}\n\n${HELP}`);
  return 1;
}

/*
 * `--as-of` USED TO BE HERE, and it was a false capability.
 *
 * It parsed a date, normalized it, and sent `as_of` — and the server does read that field, but only
 * to stamp the compiler's clock and the research contract. It never reaches the state lookup:
 * `lookupByFingerprints` takes no time argument and there is no fact-history relation, so a dated
 * check and an undated one read the identical row and return the identical verdict. The flag looked
 * like point-in-time replay and was a no-op.
 *
 * Removed rather than fixed. The demo it existed for now reproduces the reversal with a fact that
 * genuinely holds and then moves (see demo/FACTS.md in the server repo), so nothing needs the flag,
 * and shipping a verb that quietly does nothing is worse than not shipping it. If point-in-time
 * lands later it should be receipt replay — "here is the receipt we signed that day" — which is
 * durable, already signed, and a stronger claim than replaying mutable state.
 */

function parse(argv: readonly string[]): { rest: string[]; flags: Flags } {
  const rest: string[] = [];
  const flags: Flags = { json: false, all: false, fast: false, origins: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    switch (token) {
      case "--json":
        flags.json = true;
        break;
      case "--all":
        flags.all = true;
        break;
      case "--fast":
        flags.fast = true;
        break;
      case "--intent":
        flags.intent = argv[(index += 1)];
        break;
      case "--publisher-id":
        flags.publisherId = argv[(index += 1)];
        break;
      case "--as-of":
        // Accepted and ignored, loudly, so anyone with it in a script learns why rather than
        // silently getting the same answer they were already getting.
        index += 1;
        process.stderr.write(
          "kaval: --as-of is no longer supported. It never reached fact state — a dated check and " +
            "an undated one read the same row — so it has been removed rather than left to look " +
            "like point-in-time replay.\n",
        );
        break;
      case "--kind":
        flags.kind = argv[(index += 1)];
        break;
      case "--origin": {
        const value = argv[(index += 1)];
        if (value !== undefined) flags.origins.push(value);
        break;
      }
      case "--limit":
        flags.limit = argv[(index += 1)];
        break;
      case "--api-base":
        index += 1;
        break;
      default:
        rest.push(token);
    }
  }
  return { rest, flags };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    out(HELP);
    return argv.length === 0 ? 1 : 0;
  }

  const apiKey = process.env["KAVAL_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    // Refused BEFORE any network call, so a missing key never looks like a server problem.
    return usage("KAVAL_API_KEY is not set");
  }
  const baseIndex = argv.indexOf("--api-base");
  const baseUrl =
    baseIndex === -1
      ? process.env["KAVAL_API_BASE"]
      : (argv[baseIndex + 1] ?? undefined);

  const kaval = new Kaval({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  const { rest, flags } = parse(argv);
  const [command, ...tail] = rest;

  if (command === "sources") {
    const [sub, ...args] = tail;
    if (sub === "add") return sourcesAdd(kaval, args, flags);
    if (sub === "ls" || sub === "list") return sourcesList(kaval, flags);
    if (sub === "plan") return sourcesPlan(kaval, args, flags);
    return usage(`unknown sources subcommand: ${sub ?? "(none)"}`);
  }
  if (command === "check") return check(kaval, tail, flags);
  if (command === "exposure") return exposure(kaval, flags);
  if (command === "receipt") return receipt(kaval, tail);
  return usage(`unknown command: ${command ?? "(none)"}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The server's own message, not a summary of it. `kaval: 403 insufficient_scope — this API key
    // is missing the source:manage scope` is actionable; "request failed" is not.
    // The server's own payload, not a summary of it: "403 insufficient_scope — this API key is
    // missing the source:manage scope" is actionable; "request failed" is not.
    const message =
      error instanceof KavalError
        ? `${error.status} ${describePayload(error.payload)}`
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`kaval: ${message}\n`);
    process.exitCode = 1;
  });
