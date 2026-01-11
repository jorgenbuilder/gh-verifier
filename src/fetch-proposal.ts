import { HttpAgent, Actor } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { writeFileSync } from 'fs';

const GOVERNANCE_CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

// Minimal IDL for get_proposal_info
const governanceIdl = ({ IDL }: { IDL: any }) => {
  const ProposalInfo = IDL.Record({
    id: IDL.Opt(IDL.Record({ id: IDL.Nat64 })),
    proposer: IDL.Opt(IDL.Record({ id: IDL.Nat64 })),
    proposal: IDL.Opt(IDL.Record({
      title: IDL.Opt(IDL.Text),
      summary: IDL.Text,
      url: IDL.Text,
      action: IDL.Opt(IDL.Variant({
        ExecuteNnsFunction: IDL.Record({
          nns_function: IDL.Int32,
          payload: IDL.Vec(IDL.Nat8),
        }),
        // Other action types omitted for brevity
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
}

function extractCommitHash(text: string): string | null {
  // Look for git commit patterns (40-char hex)
  const commitRegex = /\b([a-f0-9]{40})\b/gi;
  const match = text.match(commitRegex);
  return match ? match[0] : null;
}

function extractWasmHash(text: string): string | null {
  // Look for WASM hash patterns - typically SHA256 (64-char hex)
  // Often labeled as "wasm hash", "module hash", etc.
  const hashRegex = /(?:wasm|module|sha256)[^\n]*?([a-f0-9]{64})/gi;
  const match = hashRegex.exec(text);
  if (match) return match[1];

  // Fallback: look for any 64-char hex string
  const genericRegex = /\b([a-f0-9]{64})\b/gi;
  const genericMatch = text.match(genericRegex);
  return genericMatch ? genericMatch[0] : null;
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

  // Try to extract commit hash and WASM hash from summary
  const combinedText = `${title}\n${summary}\n${url}`;
  const commitHash = extractCommitHash(combinedText);
  const expectedWasmHash = extractWasmHash(combinedText);

  const proposalData: ProposalData = {
    proposalId,
    title,
    summary,
    url,
    commitHash,
    expectedWasmHash,
  };

  console.log(`Title: ${title}`);
  console.log(`Commit Hash: ${commitHash || 'Not found'}`);
  console.log(`Expected WASM Hash: ${expectedWasmHash || 'Not found'}`);

  if (!commitHash) {
    console.warn('Warning: Could not extract commit hash from proposal');
  }

  if (!expectedWasmHash) {
    console.warn('Warning: Could not extract expected WASM hash from proposal');
  }

  writeFileSync('proposal.json', JSON.stringify(proposalData, null, 2));
  console.log('Wrote proposal.json');
}

main().catch((err) => {
  console.error('Error fetching proposal:', err);
  process.exit(1);
});
