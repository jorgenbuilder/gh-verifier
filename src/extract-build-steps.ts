import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

interface ProposalData {
  proposalId: string;
  title: string;
  summary: string;
  url: string;
  commitHash: string | null;
  expectedWasmHash: string | null;
  expectedArgHash: string | null;
  canisterId: string | null;
}

interface BuildSteps {
  commitHash: string;
  repoUrl: string;
  buildProfile: 'ic-monorepo' | 'standard';
  steps: string[];
  wasmOutputPath: string;
  upgradeArgs: string | null;
  upgradeArgsDid: string | null;
  upgradeArgsType: string | null;
}

export function normalizeRepoUrl(url: string): string {
  return url.replace(/\/$/, '').replace(/\.git$/, '')
    .replace(/\/tree\/[a-f0-9]+$/, '').replace(/\/commit\/[a-f0-9]+$/, '');
}

export function detectBuildProfile(repoUrl: string): 'ic-monorepo' | 'standard' {
  const normalized = normalizeRepoUrl(repoUrl);
  return normalized === 'https://github.com/dfinity/ic' ? 'ic-monorepo' : 'standard';
}

export interface ExtractedBuild {
  repoUrl: string;
  steps: string[];
  wasmOutputPath: string;
  upgradeArgs: string | null;
  upgradeArgsDid: string | null;
  upgradeArgsType: string | null;
}

/** Fenced code blocks in order, with the text preceding each (to find the heading). */
function codeBlocksAfter(summary: string, heading: RegExp): string | null {
  const lines = summary.split('\n');
  let seenHeading = false;
  let inBlock = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (!inBlock && /^#{1,6}\s/.test(line)) {
      seenHeading = heading.test(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      if (inBlock) {
        if (seenHeading) return buf.join('\n');
        inBlock = false;
        buf = [];
      } else {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return null;
}

function extractRepoUrl(summary: string): string | null {
  const repoLine = summary.match(/^Repository:\s*`?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?)(?:\.git)?`?\s*$/m);
  if (repoLine) return normalizeRepoUrl(repoLine[1]);
  const sshClone = summary.match(/git clone\s+git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m);
  if (sshClone) return `https://github.com/${sshClone[1]}`;
  const httpsClone = summary.match(/git clone\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m);
  if (httpsClone) return normalizeRepoUrl(httpsClone[1]);
  const treeLink = summary.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:tree|commit)\/[0-9a-f]{7,40}/);
  if (treeLink) return `https://github.com/${treeLink[1]}`;
  return null;
}

/** Parse a `didc encode [-d file] [-t 'type'] '<args>'` line. */
export function parseDidcLine(line: string): { args: string; did: string | null; type: string | null } | null {
  const m = line.match(/didc\s+encode\s+(.*?)\s*(?:\|\s*xxd.*)?$/);
  if (!m) return null;
  const rest = m[1];
  const did = rest.match(/-d\s+(\S+)/)?.[1] ?? null;
  const type = rest.match(/-t\s+'([^']*)'/)?.[1] ?? rest.match(/-t\s+"([^"]*)"/)?.[1] ?? null;
  // The candid value is the last single-quoted argument.
  const quoted = [...rest.matchAll(/'([^']*)'/g)].map((q) => q[1]);
  const args = quoted.length ? quoted[quoted.length - 1] : null;
  if (args === null || (type !== null && quoted.length < 2)) return null;
  return { args, did, type };
}

/**
 * Deterministically extract build instructions from the standard DFINITY proposal
 * templates ("Wasm Verification" / "WASM Verification" code block, "Upgrade args" /
 * "Upgrade Arguments Verification" didc line). Returns null if the summary does not
 * follow a recognised template, in which case the caller may fall back to the LLM.
 */
export function extractDeterministic(summary: string): ExtractedBuild | null {
  const repoUrl = extractRepoUrl(summary);
  const block = codeBlocksAfter(summary, /wasm\s+verification/i);
  if (!repoUrl || !block) return null;

  const steps: string[] = [];
  let wasmOutputPath: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^(git\s+(clone|fetch|checkout)\b|cd\s)/.test(line)) continue;
    const sha = line.match(/^sha256sum\s+(\S+)\s*$/);
    if (sha) {
      wasmOutputPath = sha[1].replace(/^\.\//, '');
      continue;
    }
    steps.push(line);
  }
  if (!wasmOutputPath || steps.length === 0) return null;

  let upgradeArgs: string | null = null;
  let upgradeArgsDid: string | null = null;
  let upgradeArgsType: string | null = null;
  const didcLine = summary.split('\n').find((l) => /didc\s+encode/.test(l));
  if (didcLine) {
    const parsed = parseDidcLine(didcLine.trim());
    if (!parsed) return null; // a didc line we can't parse: don't guess
    upgradeArgs = parsed.args;
    upgradeArgsDid = parsed.did;
    upgradeArgsType = parsed.type;
  } else {
    const candid = codeBlocksAfter(summary, /upgrade\s+arg/i);
    if (candid && candid.trim()) upgradeArgs = candid.trim();
  }

  return { repoUrl, steps, wasmOutputPath, upgradeArgs, upgradeArgsDid, upgradeArgsType };
}

const EXTRACTION_PROMPT = `You are analyzing an ICP (Internet Computer Protocol) governance proposal to extract build verification instructions.

The proposal describes a canister upgrade. Extract the repository URL, build commands, output path, and upgrade arguments. Return as JSON:

{
  "repoUrl": "https://github.com/org/repo",
  "steps": ["build command 1", "build command 2", ...],
  "wasmOutputPath": "path/to/output.wasm.gz",
  "upgradeArgs": "(record {field = value})" or null,
  "upgradeArgsDid": "canister/candid.did" or null,
  "upgradeArgsType": "(canister_arg)" or null
}

IMPORTANT:
- repoUrl: The GitHub repository URL mentioned in the proposal (e.g., https://github.com/dfinity/ic, https://github.com/dfinity/dogecoin-canister, https://github.com/dfinity/ic-boundary). If not explicitly mentioned, default to "https://github.com/dfinity/ic". Note: dfinity/ic-boundary is a SEPARATE repo, not part of dfinity/ic.
- steps: ONLY the build commands, NO git commands (clone, fetch, checkout, cd)
- wasmOutputPath: The path to the final WASM file (often ends in .wasm.gz)
- upgradeArgs: The Candid-encoded upgrade arguments if mentioned in the proposal (look for "Upgrade Arguments" section with a candid expression like "(record {allowlist = null})"). Set to null if no upgrade arguments are specified.
- upgradeArgsDid: If the proposal shows a didc encode command with -d flag (e.g., "didc encode -d canister/candid.did ..."), extract the .did file path. Set to null if not present.
- upgradeArgsType: If the proposal shows a didc encode command with -t flag (e.g., "didc encode ... -t '(canister_arg)' ..."), extract the type annotation. Set to null if not present.
- Return ONLY valid JSON, no markdown code blocks, no explanation

Common build patterns:
- dfinity/ic: Uses ./ci/container/build-ic.sh -c, output in artifacts/canisters/
- dfinity/dogecoin-canister: Uses ./scripts/docker-build or similar
- Other repos: May use cargo build, scripts/build.sh, etc.

Proposal text:
`;

async function callClaude(prompt: string): Promise<string> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required for the LLM fallback');
  }
  // Overridable so a model change is config, not code.
  const model = process.env.EXTRACT_MODEL || 'sonnet';
  console.log(`Using Claude model: ${model}`);
  // Headless Claude Code, authenticated with the same OAuth token the auto-fix
  // loop uses. Do NOT pass ANTHROPIC_API_KEY: the CLI prefers it if present.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return execFileSync(
    'npx',
    ['-y', '@anthropic-ai/claude-code', '-p', prompt, '--model', model, '--output-format', 'text'],
    { env, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
}

function parseLlmResponse(response: string): { repoUrl: string; steps: string[]; wasmOutputPath: string; upgradeArgs: string | null; upgradeArgsDid: string | null; upgradeArgsType: string | null } {
  // Try to extract JSON from the response
  let jsonStr = response.trim();

  // Remove markdown code blocks if present
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed.steps)) {
      throw new Error('Invalid response: steps must be an array');
    }

    const repoUrl = normalizeRepoUrl(parsed.repoUrl || 'https://github.com/dfinity/ic');
    return {
      repoUrl,
      steps: parsed.steps,
      wasmOutputPath: parsed.wasmOutputPath || 'output.wasm',
      upgradeArgs: parsed.upgradeArgs || null,
      upgradeArgsDid: parsed.upgradeArgsDid || null,
      upgradeArgsType: parsed.upgradeArgsType || null,
    };
  } catch (err) {
    console.error('Failed to parse LLM response:', response);
    throw new Error(`Failed to parse LLM response: ${err}`);
  }
}

async function main() {
  // Read proposal data
  let proposalData: ProposalData;
  try {
    proposalData = JSON.parse(readFileSync('proposal.json', 'utf-8'));
  } catch {
    console.error('Could not read proposal.json. Run fetch-proposal.ts first.');
    process.exit(1);
  }

  if (!proposalData.commitHash) {
    console.error('No commit hash found in proposal. Cannot proceed with build.');
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  STEP 2: EXTRACT BUILD INSTRUCTIONS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Proposal: ${proposalData.title}`);
  console.log(`Commit to build: ${proposalData.commitHash}`);

  let extracted = extractDeterministic(proposalData.summary);
  if (extracted) {
    console.log('');
    console.log('Parsed deterministically from the proposal\'s own verification');
    console.log('section (no LLM involved).');
  } else {
    console.log('');
    console.log('Summary does not match a known template; falling back to LLM.');
    console.log('TRUST ASSUMPTION: Using Claude to parse the proposal');
    console.log('summary and extract the build commands.');
    const prompt = EXTRACTION_PROMPT + `
Title: ${proposalData.title}
Summary: ${proposalData.summary}
URL: ${proposalData.url}
`;
    const response = await callClaude(prompt);
    console.log('LLM response received');
    extracted = parseLlmResponse(response);
  }

  const { repoUrl, steps, wasmOutputPath, upgradeArgs, upgradeArgsDid, upgradeArgsType } = extracted;

  console.log('');
  console.log('EXTRACTED BUILD INSTRUCTIONS:');
  console.log('─────────────────────────────────────────────────────────────────');
  const buildProfile = detectBuildProfile(repoUrl);

  console.log(`  Repository:       ${repoUrl}`);
  console.log(`  Build profile:    ${buildProfile}`);
  console.log(`  Number of steps:  ${steps.length}`);
  console.log(`  WASM output path: ${wasmOutputPath}`);
  console.log(`  Upgrade args:     ${upgradeArgs || '(none)'}`);
  if (upgradeArgsDid) console.log(`  Args .did file:   ${upgradeArgsDid}`);
  if (upgradeArgsType) console.log(`  Args type:        ${upgradeArgsType}`);

  const buildSteps: BuildSteps = {
    commitHash: proposalData.commitHash,
    repoUrl,
    buildProfile,
    steps,
    wasmOutputPath,
    upgradeArgs,
    upgradeArgsDid,
    upgradeArgsType,
  };

  writeFileSync('build-steps.json', JSON.stringify(buildSteps, null, 2));
  console.log('Wrote build-steps.json');

  console.log('');
  console.log('BUILD COMMANDS TO EXECUTE:');
  steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step}`);
  });
  console.log('─────────────────────────────────────────────────────────────────');
}

// Only run main() when executed directly, not when imported by tests
const isDirectRun = !process.env.VITEST;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Error extracting build steps:', err);
    process.exit(1);
  });
}
