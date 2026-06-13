import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

interface ProposalData {
  proposalId: string;
  title: string;
  summary: string;
  url: string;
  commitHash: string | null;
  expectedWasmHash: string | null;
  expectedArgHash: string | null;
}

interface BuildSteps {
  commitHash: string;
  repoUrl: string;
  steps: string[];
  wasmOutputPath: string;
  upgradeArgs: string | null;
  upgradeArgsDid: string | null;
  upgradeArgsType: string | null;
}

export function computeSha256(filePath: string): string {
  const fileBuffer = readFileSync(filePath);
  const hash = createHash('sha256');
  hash.update(fileBuffer);
  return hash.digest('hex');
}

export function compareHashes(actualHash: string, expectedHash: string | null): {
  match: boolean;
  status: 'verified' | 'failed' | 'error';
} {
  if (!expectedHash) {
    return { match: false, status: 'error' };
  }

  const match = actualHash.toLowerCase() === expectedHash.toLowerCase();
  return {
    match,
    status: match ? 'verified' : 'failed',
  };
}

function writeGitHubSummary(content: string) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, content + '\n');
  }
}

export function computeArgHash(upgradeArgs: string, didFile?: string | null, typeName?: string | null): string | null {
  try {
    // Build didc encode command with optional type info
    // e.g., didc encode -d canister/candid.did -t '(canister_arg)' '(variant { ... })'
    let cmd = 'didc encode';
    if (didFile) cmd += ` -d '${didFile}'`;
    if (typeName) cmd += ` -t '${typeName}'`;
    cmd += ` '${upgradeArgs}'`;

    console.log(`Running: ${cmd}`);
    const encoded = execSync(cmd, { encoding: 'utf-8' }).trim();

    // Convert hex string to bytes and compute sha256
    const bytes = Buffer.from(encoded, 'hex');
    const hash = createHash('sha256');
    hash.update(bytes);
    return hash.digest('hex');
  } catch (err) {
    console.error('Failed to compute arg hash with didc:', err);
    return null;
  }
}

async function main() {
  const wasmPath = 'output/canister.wasm';

  // Read proposal data
  let proposalData: ProposalData;
  try {
    proposalData = JSON.parse(readFileSync('proposal.json', 'utf-8'));
  } catch {
    console.error('Could not read proposal.json');
    process.exit(1);
  }

  // Read build steps for upgrade args
  let buildSteps: BuildSteps | null = null;
  try {
    buildSteps = JSON.parse(readFileSync('build-steps.json', 'utf-8'));
  } catch {
    console.warn('Could not read build-steps.json (upgrade args verification will be skipped)');
  }

  // Check WASM file exists
  if (!existsSync(wasmPath)) {
    console.error(`WASM file not found at ${wasmPath}`);
    writeGitHubSummary(`## Build Verification Failed

**Proposal:** ${proposalData.proposalId} - ${proposalData.title}

**Error:** WASM file not found after build`);
    process.exit(1);
  }

  // ===== WASM HASH VERIFICATION =====
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  WASM HASH VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  console.log('Computing SHA256 of built WASM...');
  const actualWasmHash = computeSha256(wasmPath);
  const expectedWasmHash = proposalData.expectedWasmHash;

  console.log(`Expected WASM hash: ${expectedWasmHash || 'Not found in proposal'}`);
  console.log(`Actual WASM hash:   ${actualWasmHash}`);

  const { match: wasmMatch } = compareHashes(actualWasmHash, expectedWasmHash);

  // ===== ARG HASH VERIFICATION =====
  let argMatch = true; // Default to true if no arg hash to verify
  let actualArgHash: string | null = null;
  const expectedArgHash = proposalData.expectedArgHash;
  const upgradeArgs = buildSteps?.upgradeArgs;
  const upgradeArgsDid = buildSteps?.upgradeArgsDid;
  const upgradeArgsType = buildSteps?.upgradeArgsType;

  if (expectedArgHash) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  UPGRADE ARGUMENTS HASH VERIFICATION');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    if (upgradeArgs) {
      console.log(`Upgrade args from proposal: ${upgradeArgs}`);
      if (upgradeArgsDid) console.log(`Args .did file: ${upgradeArgsDid}`);
      if (upgradeArgsType) console.log(`Args type: ${upgradeArgsType}`);
      console.log('Computing SHA256 of encoded upgrade arguments...');

      // If we have a .did file, run from the repo directory so didc can find it
      if (upgradeArgsDid && existsSync('repo')) {
        const origDir = process.cwd();
        process.chdir('repo');
        actualArgHash = computeArgHash(upgradeArgs, upgradeArgsDid, upgradeArgsType);
        process.chdir(origDir);
      } else {
        actualArgHash = computeArgHash(upgradeArgs, upgradeArgsDid, upgradeArgsType);
      }

      if (actualArgHash) {
        console.log(`Expected arg hash: ${expectedArgHash}`);
        console.log(`Actual arg hash:   ${actualArgHash}`);
        argMatch = actualArgHash.toLowerCase() === expectedArgHash.toLowerCase();
      } else {
        console.error('Failed to compute arg hash');
        argMatch = false;
      }
    } else {
      console.warn('Warning: Proposal has arg_hash but no upgrade args were extracted from summary');
      console.log(`Expected arg hash: ${expectedArgHash}`);
      console.log(`Actual arg hash:   (could not compute - no upgrade args found)`);
      argMatch = false;
    }
  }

  // ===== FINAL RESULT =====
  const overallMatch = wasmMatch && argMatch;
  const hasArgVerification = !!expectedArgHash;

  // Write GitHub Actions summary
  const wasmStatusEmoji = wasmMatch ? '✅' : (expectedWasmHash ? '❌' : '⚠️');
  const wasmStatusText = wasmMatch ? 'MATCH' : (expectedWasmHash ? 'MISMATCH' : 'CANNOT VERIFY');

  let argStatusEmoji = '';
  let argStatusText = '';
  if (hasArgVerification) {
    argStatusEmoji = argMatch ? '✅' : '❌';
    argStatusText = argMatch ? 'MATCH' : 'MISMATCH';
  }

  const overallStatusEmoji = overallMatch ? '✅' : '❌';
  const overallStatusText = overallMatch ? 'VERIFIED' : 'FAILED';

  let summary = `## Build Verification Result: ${overallStatusEmoji} ${overallStatusText}

**Proposal ID:** ${proposalData.proposalId}
**Title:** ${proposalData.title}

### WASM Hash: ${wasmStatusEmoji} ${wasmStatusText}

| Hash Type | Value |
|-----------|-------|
| Expected | \`${expectedWasmHash || 'Not found in proposal'}\` |
| Actual | \`${actualWasmHash}\` |
`;

  if (hasArgVerification) {
    summary += `
### Upgrade Args Hash: ${argStatusEmoji} ${argStatusText}

| Hash Type | Value |
|-----------|-------|
| Expected | \`${expectedArgHash}\` |
| Actual | \`${actualArgHash || 'Could not compute'}\` |
| Args | \`${upgradeArgs || 'Not found in proposal'}\` |
`;
  }

  summary += `
${overallMatch ? '### ✅ All verifications passed!' : '### ❌ Verification failed - see details above'}
`;

  console.log('\n' + '='.repeat(60));
  console.log(`WASM HASH: ${wasmMatch ? '✅ VERIFIED' : (expectedWasmHash ? '❌ FAILED' : '⚠️ CANNOT VERIFY')}`);
  if (hasArgVerification) {
    console.log(`ARG HASH:  ${argMatch ? '✅ VERIFIED' : '❌ FAILED'}`);
  }
  console.log('─'.repeat(60));
  console.log(`OVERALL:   ${overallMatch ? '✅ VERIFICATION PASSED' : '❌ VERIFICATION FAILED'}`);
  console.log('='.repeat(60));

  writeGitHubSummary(summary);

  // Machine-readable result for downstream consumers (independent verification audit).
  // Uploaded as the `verification-result` artifact (see verify.yml). Carries exactly what
  // this run computed; the auditor re-derives expected values from chain and compares.
  const result = {
    schemaVersion: 1,
    proposalId: proposalData.proposalId,
    title: proposalData.title,
    expectedWasmHash: expectedWasmHash || null,
    actualWasmHash: actualWasmHash || null,
    wasmMatch,
    hasArgVerification,
    expectedArgHash: expectedArgHash || null,
    actualArgHash: actualArgHash || null,
    argMatch,
    overallMatch,
  };
  try {
    writeFileSync('verification-result.json', JSON.stringify(result, null, 2));
    console.log('Wrote verification-result.json');
  } catch (err) {
    console.error('Failed to write verification-result.json:', err);
  }

  // Exit with appropriate code
  if (overallMatch) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// Only run main if this is the entry point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('Error comparing hashes:', err);
    process.exit(1);
  });
}
