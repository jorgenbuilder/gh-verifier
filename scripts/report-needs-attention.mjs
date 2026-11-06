#!/usr/bin/env node
// Post a "needs you" report to the reviewer portal for a verify failure that only the
// operator can fix. The report (why it failed / what to do) is written by Claude from the
// failure log; if Claude can't run (e.g. it is itself out of credits) a templated report
// with the decisive log lines is sent instead, so the alert always lands.
//
// usage: node scripts/report-needs-attention.mjs <cause> [--no-llm]
//   cause: billing_or_auth | no_fix | gave_up | hash_mismatch | other
// env: PROPOSAL_ID, RUN_URL, CRON_SECRET, PORTAL_URL?, FAILURE_LOG? (default failure.tail.log),
//      CLAUDE_CODE_OAUTH_TOKEN? (enables the LLM report)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const cause = process.argv[2] || "other";
const noLlm = process.argv.includes("--no-llm");
const { PROPOSAL_ID, RUN_URL, CRON_SECRET } = process.env;
const PORTAL_URL = process.env.PORTAL_URL || "https://proposal-reviewer-portal.vercel.app";
const logPath = process.env.FAILURE_LOG || "failure.tail.log";

if (!PROPOSAL_ID) { console.error("PROPOSAL_ID required"); process.exit(0); }
if (!CRON_SECRET) { console.log("no CRON_SECRET; skipping portal report"); process.exit(0); }

const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
const notes = existsSync("FIX_NOTES.md") ? readFileSync("FIX_NOTES.md", "utf-8") : "";

// Decisive lines for the fallback (and as a hint to the LLM): errors near the end of the log.
const stripTs = (l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\x1b\[[0-9;]*m/g, "");
const errorLines = log
  .split("\n")
  .map(stripTs)
  .filter((l) => /error|failed|denied|402|401|403|exhausted|credit|invalid|mismatch/i.test(l))
  .filter((l) => !/^\s*(at |\[command\])/.test(l))
  .slice(-12);

function llmReport() {
  if (noLlm || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;
  const prompt =
    readFileSync(new URL("./diagnose-prompt.md", import.meta.url), "utf-8")
      .replaceAll("{{PROPOSAL_ID}}", PROPOSAL_ID)
      .replaceAll("{{CAUSE}}", cause) +
    (notes ? `\n\n## Auto-fix notes from the earlier attempt\n\n${notes.slice(0, 6000)}\n` : "") +
    `\n\n## Failure log (tail)\n\n\`\`\`\n${log.slice(-40000)}\n\`\`\`\n`;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // the CLI prefers it over the OAuth token
  try {
    const out = execFileSync("claude", ["-p", prompt, "--model", "sonnet", "--output-format", "text"], {
      env, encoding: "utf-8", timeout: 4 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
    const m = out.match(/^Summary:\s*(.+)$/m);
    if (!m || !/## What you need to do/.test(out)) {
      console.log("LLM output not in the expected format; using fallback.\n" + out.slice(0, 500));
      return null;
    }
    return { summary: m[1].trim(), report: out.slice(out.indexOf(m[0]) + m[0].length).trim() };
  } catch (e) {
    console.log("LLM report failed; using fallback:", String(e.message || e).slice(0, 300));
    return null;
  }
}

function fallbackReport() {
  const what = {
    billing_or_auth:
      "1. A service the verifier depends on rejected its credential or is out of credits. Check the error below for which one.\n2. Top up / rotate it, and update the matching secret at https://github.com/jorgenbuilder/gh-verifier/settings/secrets/actions if the key changed.",
    no_fix: "1. Read the failed run and the auto-fix notes on the open gh-verifier issue.\n2. Repair the verifier (or the environment) by hand.",
    gave_up: "1. The auto-fix loop hit its attempt cap. Read the latest failed run.\n2. Repair the verifier by hand.",
    hash_mismatch: "1. Reproduce the build locally and confirm the on-chain module hash.\n2. Do not adopt until resolved.",
    other: "1. Read the failed run and fix the cause.",
  }[cause] || "1. Read the failed run and fix the cause.";
  const then = cause === "hash_mismatch"
    ? "Do NOT retry; investigate before adopting."
    : "Press **Fixed it, retry verification**.";
  const summary = {
    billing_or_auth: "Verifier blocked by a billing or credential failure",
    no_fix: "Auto-fix found nothing to change; needs a manual fix",
    gave_up: "Auto-fix gave up after repeated failures",
    hash_mismatch: "Built WASM hash does not match the proposal",
    other: "Verification failed and needs attention",
  }[cause] || "Verification failed and needs attention";
  return {
    summary,
    report:
      `## Why it failed\n\n(Automatic diagnosis unavailable; decisive log lines below.)\n\n` +
      "```\n" + (errorLines.join("\n") || "(no error lines found in the log tail)") + "\n```\n\n" +
      `## What you need to do\n\n${what}\n\n## Then\n\n${then}`,
  };
}

const { summary, report } = llmReport() || fallbackReport();
const body = {
  proposalId: PROPOSAL_ID,
  type: "needs_attention",
  cause,
  summary,
  report,
  runUrl: RUN_URL,
  retryable: cause !== "hash_mismatch",
};
const res = await fetch(`${PORTAL_URL}/api/verification-event`, {
  method: "POST",
  headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
console.log(`portal report (${cause}): ${res.status} ${(await res.text()).slice(0, 200)}`);
console.log(`Summary: ${summary}`);
