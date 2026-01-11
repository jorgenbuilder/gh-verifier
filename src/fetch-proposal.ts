import { HttpAgent, Actor } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { writeFileSync } from 'fs';

const GOVERNANCE_CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

// IDL for get_proposal_info with InstallCode action variant
const governanceIdl = ({ IDL }: { IDL: any }) => {
  const InstallCode = IDL.Record({
    skip_stopping_before_installing: IDL.Opt(IDL.Bool),
    wasm_module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    canister_id: IDL.Opt(IDL.Principal),
    arg_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    install_mode: IDL.Opt(IDL.Int32),
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

  console.log(`Fetching proposal ${proposalId}...`);

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

  // Extract wasm_module_hash directly from InstallCode action
  let expectedWasmHash: string | null = null;
  let canisterId: string | null = null;

  const action = proposal.action?.[0];
  if (action?.InstallCode) {
    const installCode = action.InstallCode;

    // Extract wasm_module_hash from bytes
    if (installCode.wasm_module_hash?.[0]) {
      expectedWasmHash = bytesToHex(installCode.wasm_module_hash[0]);
    }

    // Extract canister_id
    if (installCode.canister_id?.[0]) {
      canisterId = installCode.canister_id[0].toText();
    }
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

  console.log(`Title: ${title}`);
  console.log(`Canister ID: ${canisterId || 'Not found'}`);
  console.log(`Commit Hash: ${commitHash || 'Not found'}`);
  console.log(`Expected WASM Hash (from onchain): ${expectedWasmHash || 'Not found'}`);

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
