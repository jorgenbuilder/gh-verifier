import { readFileSync, appendFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

interface ProposalData {
  proposalId: string;
  title: string;
  summary: string;
  url: string;
  commitHash: string | null;
  expectedWasmHash: string | null;
}

function computeSha256(filePath: string): string {
  const fileBuffer = readFileSync(filePath);
  const hash = createHash('sha256');
  hash.update(fileBuffer);
  return hash.digest('hex');
}

function writeGitHubSummary(content: string) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, content + '\n');
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

  // Check WASM file exists
  if (!existsSync(wasmPath)) {
    console.error(`WASM file not found at ${wasmPath}`);
    writeGitHubSummary(`## Build Verification Failed

**Proposal:** ${proposalData.proposalId} - ${proposalData.title}

**Error:** WASM file not found after build`);
    process.exit(1);
  }

  // Compute hash of built WASM
  console.log('Computing SHA256 of built WASM...');
  const actualHash = computeSha256(wasmPath);
  const expectedHash = proposalData.expectedWasmHash;

  console.log(`Expected hash: ${expectedHash || 'Not found in proposal'}`);
  console.log(`Actual hash:   ${actualHash}`);

  // Compare
  const match = expectedHash && actualHash.toLowerCase() === expectedHash.toLowerCase();

  // Write GitHub Actions summary
  const statusEmoji = match ? '✅' : (expectedHash ? '❌' : '⚠️');
  const statusText = match ? 'MATCH' : (expectedHash ? 'MISMATCH' : 'CANNOT VERIFY');

  const summary = `## Build Verification Result: ${statusEmoji} ${statusText}

**Proposal ID:** ${proposalData.proposalId}
**Title:** ${proposalData.title}

| Hash Type | Value |
|-----------|-------|
| Expected | \`${expectedHash || 'Not found in proposal'}\` |
| Actual | \`${actualHash}\` |

${match ? '### ✅ Build verification successful!' : ''}
${!match && expectedHash ? '### ❌ Hash mismatch - build does not match expected WASM' : ''}
${!expectedHash ? '### ⚠️ Could not verify - expected hash not found in proposal' : ''}
`;

  console.log('\n' + '='.repeat(60));
  console.log(match ? '✅ VERIFICATION PASSED' : (expectedHash ? '❌ VERIFICATION FAILED' : '⚠️ CANNOT VERIFY'));
  console.log('='.repeat(60));

  writeGitHubSummary(summary);

  // Exit with appropriate code
  if (match) {
    process.exit(0);
  } else if (expectedHash) {
    process.exit(1); // Mismatch
  } else {
    // No expected hash - warn but don't fail
    console.warn('Warning: Could not verify because expected hash was not found in proposal');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Error comparing hashes:', err);
  process.exit(1);
});
