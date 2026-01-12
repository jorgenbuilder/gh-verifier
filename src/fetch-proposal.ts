import { HttpAgent, Actor } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { writeFileSync } from 'fs';

const GOVERNANCE_CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

// IDL for get_proposal_info with action variants
const governanceIdl = ({ IDL }: { IDL: any }) => {
  const InstallCode = IDL.Record({
    skip_stopping_before_installing: IDL.Opt(IDL.Bool),
    wasm_module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    canister_id: IDL.Opt(IDL.Principal),
    arg_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    install_mode: IDL.Opt(IDL.Int32),
  });

  // Minimal record for other action types (we only need to detect them, not process them)
  const UpdateCanisterSettings = IDL.Record({
    canister_id: IDL.Opt(IDL.Principal),
    settings: IDL.Opt(IDL.Record({})),
  });

  const ProposalInfo = IDL.Record({
    id: IDL.Opt(IDL.Record({ id: IDL.Nat64 })),
    proposer: IDL.Opt(IDL.Record({ id: IDL.Nat64 })),
    proposal: IDL.Opt(IDL.Record({
      title: IDL.Opt(IDL.Text),
      summary: IDL.Text,
      url: IDL.Text,
      action: IDL.Opt(IDL.Variant({
        InstallCode: InstallCode,
        UpdateCanisterSettings: UpdateCanisterSettings,
        // Other action types will be captured as unknown variants
      })),
    })),
    status: IDL.Int32,
    executed_timestamp_seconds: IDL.Nat64,
  });

  return IDL.Service({
    get_proposal_info: IDL.Func([IDL.Nat64], [IDL.Opt(ProposalInfo)], ['query']),
  });
};

interface ProposalData {
  proposalId: string;
  title: string;
  summary: string;
  url: string;
  commitHash: string | null;
  expectedWasmHash: string | null;
  canisterId: string | null;
}

function extractCommitHash(text: string): string | null {
  // Look for git commit patterns (40-char hex)
  const commitRegex = /\b([a-f0-9]{40})\b/gi;
  const match = text.match(commitRegex);
  return match ? match[0] : null;
}

function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const proposalId = process.argv[2];

  if (!proposalId) {
    console.error('Usage: tsx fetch-proposal.ts <proposal_id>');
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  STEP 1: FETCH PROPOSAL FROM NNS GOVERNANCE (ONCHAIN)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('TRUST ASSUMPTION: Querying the NNS Governance canister directly');
  console.log('to retrieve the official proposal data from the IC blockchain.');
  console.log('');
  console.log(`Proposal ID: ${proposalId}`);
  console.log(`Governance Canister: ${GOVERNANCE_CANISTER_ID}`);
  console.log(`IC Endpoint: https://ic0.app`);
  console.log('');

  const agent = new HttpAgent({ host: 'https://ic0.app' });

  const governance = Actor.createActor(governanceIdl, {
    agent,
    canisterId: Principal.fromText(GOVERNANCE_CANISTER_ID),
  });

  const result = await governance.get_proposal_info(BigInt(proposalId)) as any;

  if (!result || result.length === 0 || !result[0]) {
    console.error(`Proposal ${proposalId} not found`);
    process.exit(1);
  }

  const proposalInfo = result[0];
  const proposal = proposalInfo.proposal?.[0];

  if (!proposal) {
    console.error('Proposal data is empty');
    process.exit(1);
  }

  const title = proposal.title?.[0] || 'Untitled';
  const summary = proposal.summary || '';
  const url = proposal.url || '';

  // Check if this is an InstallCode action (code upgrade)
  // Other action types (UpdateCanisterSettings, etc.) don't have code to verify
  const action = proposal.action?.[0];

  if (!action) {
    console.log('');
    console.log('⏭️  SKIPPED: Proposal has no action data');
    console.log('');
    // Exit code 78 = neutral (GitHub Actions shows as skipped/gray)
    process.exit(78);
  }

  if (!action.InstallCode) {
    // Determine the action type for logging
    const actionType = Object.keys(action)[0] || 'Unknown';
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ⏭️  SKIPPED: NOT A CODE UPGRADE PROPOSAL');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Proposal ID:   ${proposalId}`);
    console.log(`  Title:         ${title}`);
    console.log(`  Action Type:   ${actionType}`);
    console.log('');
    console.log('  This proposal does not install code, so there is no WASM to verify.');
    console.log('  Only InstallCode proposals require build verification.');
    console.log('');
    // Exit code 78 = neutral (GitHub Actions shows as skipped/gray)
    process.exit(78);
  }

  // Extract wasm_module_hash directly from InstallCode action
  let expectedWasmHash: string | null = null;
  let canisterId: string | null = null;

  const installCode = action.InstallCode;

  // Extract wasm_module_hash from bytes
  if (installCode.wasm_module_hash?.[0]) {
    expectedWasmHash = bytesToHex(installCode.wasm_module_hash[0]);
  }

  // Extract canister_id
  if (installCode.canister_id?.[0]) {
    canisterId = installCode.canister_id[0].toText();
  }

  // Extract commit hash from summary text
  const combinedText = `${title}\n${summary}\n${url}`;
  const commitHash = extractCommitHash(combinedText);

  const proposalData: ProposalData = {
    proposalId,
    title,
    summary,
    url,
    commitHash,
    expectedWasmHash,
    canisterId,
  };

  console.log('PROPOSAL DATA RETRIEVED:');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`  Title:             ${title}`);
  console.log(`  Target Canister:   ${canisterId || 'Not found'}`);
  console.log(`  Source Commit:     ${commitHash || 'Not found'}`);
  console.log('');
  console.log('ONCHAIN WASM HASH (from proposal.action.InstallCode.wasm_module_hash):');
  console.log(`  ${expectedWasmHash || 'Not found'}`);
  console.log('');
  console.log('This hash was extracted directly from the onchain proposal payload,');
  console.log('not from the human-readable summary text.');
  console.log('─────────────────────────────────────────────────────────────────');

  if (!commitHash) {
    console.warn('Warning: Could not extract commit hash from proposal');
  }

  if (!expectedWasmHash) {
    console.error('Error: Could not extract wasm_module_hash from proposal action');
    process.exit(1);
  }

  writeFileSync('proposal.json', JSON.stringify(proposalData, null, 2));
  console.log('Wrote proposal.json');
}

main().catch((err) => {
  console.error('Error fetching proposal:', err);
  process.exit(1);
});
