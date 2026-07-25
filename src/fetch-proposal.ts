import { HttpAgent, Actor } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { IDL } from '@dfinity/candid';
import { writeFileSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';

const GOVERNANCE_CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

// NnsFunction ids for the legacy ExecuteNnsFunction action. Both embed the full
// wasm module in their payload. Source: dfinity/ic
// rs/nns/governance/proto/ic_nns_governance/pb/v1/governance.proto
const NNS_FUNCTION_NNS_CANISTER_INSTALL = 3;
const NNS_FUNCTION_NNS_CANISTER_UPGRADE = 4;

function setGitHubOutput(name: string, value: string) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

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

  // Legacy code action. NnsCanisterInstall/Upgrade carry the full wasm module in
  // the payload blob, which we decode and hash ourselves.
  const ExecuteNnsFunction = IDL.Record({
    nns_function: IDL.Int32,
    payload: IDL.Vec(IDL.Nat8),
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
        ExecuteNnsFunction: ExecuteNnsFunction,
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
  expectedArgHash: string | null;
  canisterId: string | null;
}

export function extractCommitHash(text: string): string | null {
  // Prefer an explicitly-labelled commit. Newer proposal summaries reference the
  // source as an abbreviated hash (e.g. "commit 6590c85f") rather than a full
  // 40-char hash, and the surrounding text also contains the 64-char wasm hash
  // and its short form (e.g. "hash d7b1cde1"). Anchoring on the "commit" keyword
  // picks the right token and avoids matching a wasm-hash fragment. git resolves
  // abbreviated hashes on checkout, so a 7+ char prefix is sufficient.
  const labelled = text.match(/\bcommit[:\s]+([a-f0-9]{7,40})\b/i);
  if (labelled) return labelled[1];

  // Fall back to a standalone full-length (40-char) git commit hash.
  const full = text.match(/\b([a-f0-9]{40})\b/i);
  return full ? full[1] : null;
}

function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// NnsCanisterInstall (AddNnsCanisterProposalPayload) and NnsCanisterUpgrade
// (ChangeNnsCanisterProposalPayload) both embed the full module in a
// `wasm_module: blob` field. Candid record subtyping lets us decode just that
// field; its SHA-256 is the wasm hash the dashboard displays and what we verify
// the reproduced build against.
export function legacyWasmHashFromPayload(payload: number[]): string {
  const PayloadWithWasm = IDL.Record({ wasm_module: IDL.Vec(IDL.Nat8) });
  const [decoded] = IDL.decode([PayloadWithWasm], Uint8Array.from(payload).buffer) as any[];
  const wasm = Uint8Array.from(decoded.wasm_module);
  return createHash('sha256').update(wasm).digest('hex');
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

  // Determine what kind of action this proposal carries:
  //  - InstallCode: modern action; wasm/arg hashes are onchain directly.
  //  - ExecuteNnsFunction NnsCanisterInstall/Upgrade: legacy action that embeds
  //    the full wasm module in its payload, which we decode and hash ourselves.
  //  - anything else: no canister code, so there is nothing to verify -> skip.
  const action = proposal.action?.[0];

  let expectedWasmHash: string | null = null;
  let expectedArgHash: string | null = null;
  let canisterId: string | null = null;

  if (action?.InstallCode) {
    const installCode = action.InstallCode;
    if (installCode.wasm_module_hash?.[0]) {
      expectedWasmHash = bytesToHex(installCode.wasm_module_hash[0]);
    }
    if (installCode.arg_hash?.[0]) {
      expectedArgHash = bytesToHex(installCode.arg_hash[0]);
    }
    if (installCode.canister_id?.[0]) {
      canisterId = installCode.canister_id[0].toText();
    }
  } else if (
    action?.ExecuteNnsFunction &&
    (action.ExecuteNnsFunction.nns_function === NNS_FUNCTION_NNS_CANISTER_INSTALL ||
      action.ExecuteNnsFunction.nns_function === NNS_FUNCTION_NNS_CANISTER_UPGRADE)
  ) {
    const fn = action.ExecuteNnsFunction.nns_function;
    const fnName =
      fn === NNS_FUNCTION_NNS_CANISTER_INSTALL ? 'NnsCanisterInstall' : 'NnsCanisterUpgrade';
    console.log(`Legacy code action: ExecuteNnsFunction / ${fnName} (nns_function=${fn})`);
    console.log('Decoding embedded wasm_module from payload to derive the expected hash...');
    try {
      expectedWasmHash = legacyWasmHashFromPayload(action.ExecuteNnsFunction.payload);
    } catch (err) {
      console.error('Error: failed to decode wasm_module from ExecuteNnsFunction payload:', err);
      process.exit(1);
    }
    // The wasm is embedded directly; there is no separately-encoded upgrade arg
    // to reproduce from source, so we verify the wasm hash only.
  } else {
    const actionType = action ? Object.keys(action)[0] || 'Unknown' : 'no_action_data';
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ⏭️  SKIPPED: NOT A CODE PROPOSAL');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Proposal ID:   ${proposalId}`);
    console.log(`  Title:         ${title}`);
    console.log(`  Action Type:   ${actionType}`);
    console.log('');
    console.log('  This proposal does not install or upgrade canister code, so');
    console.log('  there is no WASM to verify.');
    console.log('');
    // Make the run page honest: a skip is NOT a verification pass.
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      appendFileSync(
        summaryFile,
        `## ⏭️ Verification skipped\n\n` +
          `Proposal #${proposalId} (action: \`${actionType}\`) does not install or ` +
          `upgrade canister code, so there is nothing to build. ` +
          `**This is not a build verification.**\n`
      );
    }
    setGitHubOutput('skipped', 'true');
    setGitHubOutput('skip_reason', actionType);
    process.exit(0);
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
    expectedArgHash,
    canisterId,
  };

  console.log('PROPOSAL DATA RETRIEVED:');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`  Title:             ${title}`);
  console.log(`  Target Canister:   ${canisterId || 'Not found'}`);
  console.log(`  Source Commit:     ${commitHash || 'Not found'}`);
  console.log('');
  console.log('EXPECTED WASM HASH (onchain):');
  console.log(`  ${expectedWasmHash || 'Not found'}`);
  console.log('');
  console.log('EXPECTED ARG HASH (onchain):');
  console.log(`  ${expectedArgHash || 'Not found (no separate upgrade arguments)'}`);
  console.log('');
  console.log('These hashes are derived directly from the onchain proposal payload,');
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

// Only run main() when executed directly, not when imported by tests
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error('Error fetching proposal:', err);
    process.exit(1);
  });
}
