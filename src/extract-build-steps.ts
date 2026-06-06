import { GoogleGenAI } from '@google/genai';
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

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  const ai = new GoogleGenAI({ apiKey });

  // Overridable so a future model deprecation is a config change, not a code
  // change. gemini-2.0-flash was retired by Google (404 "no longer available").
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log(`Using Gemini model: ${model}`);

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  });

  return response.text || '';
}

function parseGeminiResponse(response: string): { repoUrl: string; steps: string[]; wasmOutputPath: string; upgradeArgs: string | null; upgradeArgsDid: string | null; upgradeArgsType: string | null } {
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
    console.error('Failed to parse Gemini response:', response);
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
  console.log('  STEP 2: EXTRACT BUILD INSTRUCTIONS VIA LLM');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('TRUST ASSUMPTION: Using Google Gemini to parse the proposal');
  console.log('summary and extract the build commands. The LLM interprets the');
  console.log('human-readable instructions to determine how to build the WASM.');
  console.log('');
  console.log(`Proposal: ${proposalData.title}`);
  console.log(`Commit to build: ${proposalData.commitHash}`);

  const prompt = EXTRACTION_PROMPT + `
Title: ${proposalData.title}
Summary: ${proposalData.summary}
URL: ${proposalData.url}
`;

  const response = await callGemini(prompt);
  console.log('Gemini response received');

  const { repoUrl, steps, wasmOutputPath, upgradeArgs, upgradeArgsDid, upgradeArgsType } = parseGeminiResponse(response);

  console.log('');
  console.log('LLM EXTRACTED BUILD INSTRUCTIONS:');
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
