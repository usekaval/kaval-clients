#!/usr/bin/env node
/** Validates the package release and official MCP Registry publication workflows. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "release.yml",
);
const yaml = readFileSync(workflowPath, "utf8");
const registryWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "publish-mcp-registry.yml",
);
const registryYaml = readFileSync(registryWorkflowPath, "utf8");

let fail = 0;
const check = (name, cond) => {
  console.error(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

function jobIds(content) {
  const start = content.indexOf("\njobs:\n");
  if (start < 0) return [];
  const rest = content.slice(start + "\njobs:\n".length);
  return [...rest.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);
}

function jobBlock(content, jobId) {
  const marker = `\n  ${jobId}:\n`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const after = content.slice(start + marker.length);
  const next = after.search(/^  [a-z][a-z0-9_-]*:\s*$/m);
  return next < 0 ? after : after.slice(0, next);
}

/** True when `first` appears in the job and `second` appears after it. */
function ordered(job, first, second) {
  const a = job.search(first);
  const b = job.search(second);
  return a >= 0 && b > a;
}

// Match the publish *step*, not the prose about it: the jobs carry comments that name the command
// they run, and those comments sit above the steps they explain.
const NPM_PUBLISH_STEP = /^\s+run: npm publish/m;
const PNPM_PUBLISH_STEP = /^\s+run: pnpm publish/m;

check(
  "triggers on push tags v*",
  /push:\s*\n\s+tags:\s*\n\s+- "v\*"/.test(yaml),
);
check("supports workflow_dispatch", /workflow_dispatch:/.test(yaml));

const jobs = jobIds(yaml);
check(
  "defines npm, mcp, pypi, official MCP Registry, and kaval pin-dispatch jobs",
  jobs.join(",") === "npm,mcp,pypi,mcp_registry,notify_kaval",
);

const npm = jobBlock(yaml, "npm");
const mcp = jobBlock(yaml, "mcp");
const pypi = jobBlock(yaml, "pypi");
const mcpRegistry = jobBlock(yaml, "mcp_registry");
const notifyKaval = jobBlock(yaml, "notify_kaval");

check(
  "npm job publishes with NPM_TOKEN + provenance",
  /secrets\.NPM_TOKEN/.test(npm) && /npm publish --provenance/.test(npm),
);
check("mcp job needs npm first", /needs:\s*(\[npm\]|npm\b)/.test(mcp));
check(
  "mcp job publishes packages/mcp with provenance",
  /packages\/mcp/.test(mcp) && /pnpm publish[^\n]*--provenance/.test(mcp),
);
// npm provenance is minted from the job's OIDC token; without `id-token: write` the publish either
// fails or silently ships unattested, depending on the npm version.
check(
  "both npm-publishing jobs request the OIDC token provenance needs",
  [npm, mcp].every((job) => /id-token:\s*write/.test(job)),
);
check("pypi job is ordered behind npm", /needs:\s*(\[npm\]|npm\b)/.test(pypi));
check(
  "pypi job uses OIDC environment",
  /environment:\s*pypi/.test(pypi) && /gh-action-pypi-publish/.test(pypi),
);

// ---------------------------------------------------------------------------
// What publishing is gated on.
//
// It is NOT gated on a live server, and a future edit must not make it so. Publish jobs use
// NPM_TOKEN (and PyPI OIDC). KAVAL_DISPATCH_TOKEN exists only to notify usekaval/kaval AFTER a
// successful tag publish. There is no staging deployment, and the only real server is production —
// where a release-time test run would write sources, receipts and outcome reports into the live
// product on every tag. The public repo gates on what it can honestly run by itself; the real
// client↔server contract test lives in the private repo's CI, which is the only place both the
// clients and a server exist. These checks pin that down in both directions: no credentialed gate
// creeps back in, and the hermetic suites that replaced it actually run before each publish.
// ---------------------------------------------------------------------------

check(
  "no job gates a publish on a staging credential this repository does not have",
  !/KAVAL_STAGING/.test(yaml) &&
    !/live_gate/.test(yaml) &&
    ![npm, mcp, pypi, mcpRegistry].some((job) => /secrets\.KAVAL_/.test(job)),
);
check(
  "pin-dispatch runs after all three publishes, on tags only, and is not a publish",
  /needs:\s*\[npm,\s*mcp,\s*pypi\]/.test(notifyKaval) &&
    /if: startsWith\(github\.ref, 'refs\/tags\/'\)/.test(notifyKaval) &&
    /secrets\.KAVAL_DISPATCH_TOKEN/.test(notifyKaval) &&
    /kaval-clients-released/.test(notifyKaval) &&
    !NPM_PUBLISH_STEP.test(notifyKaval) &&
    !PNPM_PUBLISH_STEP.test(notifyKaval) &&
    !/gh-action-pypi-publish/.test(notifyKaval),
);
check(
  "no publish is gated on reaching a real server",
  !/live-tools\.test\.ts/.test(yaml) && !/tests\/test_live\.py/.test(yaml),
);
check(
  "the npm job builds and tests the Node SDK before publishing it",
  ordered(
    npm,
    /pnpm --filter @usekaval\/kaval run build && pnpm --filter @usekaval\/kaval run test/,
    NPM_PUBLISH_STEP,
  ),
);
check(
  "the mcp job builds and tests the MCP server before publishing it",
  ordered(
    mcp,
    /pnpm --filter "@usekaval\/mcp\.\.\." run build && pnpm --filter @usekaval\/mcp run test/,
    PNPM_PUBLISH_STEP,
  ),
);
check(
  "the pypi job tests and typechecks before building the artifact it uploads",
  ordered(pypi, /\n\s+pytest\n/, /python -m build/) &&
    ordered(pypi, /pyright --warnings/, /python -m build/),
);
// A tag is one release across three registries. Publishing a package whose manifest disagrees with
// the tag is how `v0.1.3` ends up meaning a different version on npm than on PyPI.
check(
  "every publishing job refuses a tag that disagrees with its own manifest version",
  [npm, mcp, pypi].every(
    (job) =>
      /if: startsWith\(github\.ref, 'refs\/tags\/'\)/.test(job) &&
      /GITHUB_REF_NAME/.test(job),
  ) &&
    ordered(npm, /GITHUB_REF_NAME/, NPM_PUBLISH_STEP) &&
    ordered(mcp, /GITHUB_REF_NAME/, PNPM_PUBLISH_STEP) &&
    ordered(pypi, /GITHUB_REF_NAME/, /python -m build/),
);

check(
  "registry job waits for MCP npm publication",
  /needs:\s*(\[mcp\]|mcp\b)/.test(mcpRegistry),
);
check(
  "registry job calls the dedicated reusable workflow with OIDC",
  /uses:\s*\.\/\.github\/workflows\/publish-mcp-registry\.yml/.test(
    mcpRegistry,
  ) && /id-token:\s*write/.test(mcpRegistry),
);
check(
  "registry workflow supports workflow_call",
  /workflow_call:/.test(registryYaml),
);
check(
  "registry workflow supports workflow_dispatch recovery",
  /workflow_dispatch:/.test(registryYaml),
);
check(
  "registry workflow grants only its publish job OIDC",
  /id-token:\s*write/.test(registryYaml),
);
check(
  "registry workflow verifies the immutable version before publishing",
  /versions\/\$encoded_version/.test(registryYaml),
);
check(
  "registry workflow pins and verifies mcp-publisher",
  /v1\.7\.9/.test(registryYaml) && /sha256sum --check/.test(registryYaml),
);
check(
  "registry workflow authenticates with GitHub OIDC",
  /login github-oidc/.test(registryYaml),
);
check(
  "registry workflow publishes the explicit server manifest",
  /publish packages\/mcp\/server\.json/.test(registryYaml),
);

if (fail > 0) {
  console.error(`\n${fail} check(s) failed.`);
  process.exit(1);
}
console.error("\nRelease + official MCP Registry workflows OK.");
