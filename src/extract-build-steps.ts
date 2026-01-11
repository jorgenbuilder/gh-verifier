import { readFileSync, writeFileSync } from 'fs';

interface ProposalData {
  proposalId: string;
  title: string;
  summary: string;
  url: string;
  commitHash: string | null;
  expectedWasmHash: string | null;
}

interface BuildSteps {
  commitHash: string;
  steps: string[];
  wasmOutputPath: string;
}

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const EXTRACTION_PROMPT = `You are analyzing an ICP (Internet Computer Protocol) governance proposal to extract build verification instructions.

The proposal describes a canister upgrade. Extract the following information and return it as JSON:

1. The exact shell commands needed to build the WASM file from the dfinity/ic repository
2. The expected output path of the WASM file after building

Return ONLY valid JSON in this exact format, no markdown code blocks, no explanation:
{
  "steps": ["command1", "command2", ...],
  "wasmOutputPath": "path/to/output.wasm"
}

Common build patterns for dfinity/ic:
- Uses Bazel for building
- Canisters are typically built with: bazel build //rs/path/to/canister:canister_name
- Output is usually in bazel-bin/rs/path/to/canister/

If you cannot determine the exact build steps, provide reasonable defaults based on the canister name mentioned.

Proposal text:
`;

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  // Build URL without exposing key in any error messages
  const url = new URL(GEMINI_API_URL);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1, // Low temperature for more deterministic output
        maxOutputTokens: 1024,
      }
    })
  });

  if (!response.ok) {
    // Don't include full error text which might contain URL with key
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseGeminiResponse(response: string): { steps: string[]; wasmOutputPath: string } {
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

    return {
      steps: parsed.steps,
      wasmOutputPath: parsed.wasmOutputPath || 'output.wasm'
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

  console.log('Extracting build steps from proposal...');
  console.log(`Title: ${proposalData.title}`);

  const prompt = EXTRACTION_PROMPT + `
Title: ${proposalData.title}
Summary: ${proposalData.summary}
URL: ${proposalData.url}
`;

  const response = await callGemini(prompt);
  console.log('Gemini response received');

  const { steps, wasmOutputPath } = parseGeminiResponse(response);

  console.log(`Extracted ${steps.length} build steps`);
  console.log(`WASM output path: ${wasmOutputPath}`);

  const buildSteps: BuildSteps = {
    commitHash: proposalData.commitHash,
    steps,
    wasmOutputPath,
  };

  writeFileSync('build-steps.json', JSON.stringify(buildSteps, null, 2));
  console.log('Wrote build-steps.json');

  // Also log the steps for visibility in GitHub Actions
  console.log('\nBuild steps:');
  steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step}`);
  });
}

main().catch((err) => {
  console.error('Error extracting build steps:', err);
  process.exit(1);
});
