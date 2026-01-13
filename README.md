# ICP Governance Proposal Verifier

This repository automatically verifies code for all new governance proposals in the Internet Computer's **Protocol Canister Management** topic. It provides an independent, transparent verification layer for the ICP community. It runs entirely on github actions and crons.

## What It Does

When DFINITY or other parties submit proposals to upgrade canisters on the Internet Computer, they include:

- A description of the changes
- Build instructions
- The expected WASM hash of the compiled code

This verifier:

1. Fetches proposal data directly from the NNS governance canister on-chain
2. Extracts build instructions from the proposal text
3. Reproducibly builds the code in a standardized container
4. Compares the resulting WASM hash against the on-chain expected hash

A matching hash indicates that the code described in the proposal is indeed what will be deployed.

## Why This Matters

Governance proposals are the mechanism by which the Internet Computer evolves. When voters approve a proposal to upgrade a canister, they're trusting that the binary being deployed matches what was described. This verifier disperses that trust requirement by providing another cryptographic proof.

## Trust Assumptions

This system is transparent about what it trusts:

| Component              | Trust Assumption                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blockchain data**    | Proposal data is fetched directly from the NNS governance canister. The Internet Computer's consensus mechanism guarantees this data is canonical. |
| **Git commits**        | The commit hash cryptographically identifies a specific code snapshot. As long as the code can be retrieve, it's guaranteed to be correct.         |
| **Build environment**  | Builds run in DFINITY's official `ghcr.io/dfinity/ic-build` container image, ensuring a standardized, reproducible environment.                    |
| **Build instructions** | An LLM (Google Gemini) extracts build steps from the proposal text. This is the weakest link—ambiguous instructions could be misinterpreted.       |
| **GitHub Actions**     | The execution environment is provided by GitHub. See below for discussion on this.                                                                 |

## What Makes This Good

**Blockchain-grounded verification**: The expected WASM hash comes directly from the on-chain proposal payload, not from any off-chain source. This is the same hash that will be enforced when the proposal executes.

**Reproducible builds**: Using a standardized container and exact commit checkout ensures anyone can reproduce the same build.

**Fully automated**: A monitor runs hourly to detect new proposals and trigger verification automatically. No manual intervention required.

**Auditable**: Every verification run is logged in GitHub Actions with full console output. Anyone can inspect exactly what happened.

**Transparent failures**: When verification fails or cannot be completed, the system clearly explains why rather than silently passing.

## On GitHub Actions as an Execution Environment

GitHub Actions provides a reasonable execution environment for decentralized governance verification:

- **Publicly auditable**: All workflow runs, logs, and outputs are visible to anyone
- **Reproducible**: Workflows are defined in code and versioned in git
- **Independent**: GitHub has no stake in ICP governance outcomes
- **Accessible**: Anyone can fork this repository and run their own verification

**However, GitHub Actions alone is insufficient for truly decentralized verification.** GitHub is a single centralized provider that could theoretically:

- Modify execution environments
- Suppress or alter results
- Experience outages during critical votes

For robust decentralized governance, verification should happen across **multiple independent environments**:

- Different CI providers (GitHub, GitLab, self-hosted runners)
- Independent community members running local verification
- On-chain verification mechanisms where feasible

This repository is one node in what should be a diverse verification network. The more independent verifiers that confirm a proposal's code, the stronger the community's confidence.

## Next

The reason I decided to use github is mostly for it's publicly auditable logs. Running verifications on hardware physically owned and controlled by individuals feels to me like the most resilient and distributed solution to build verification for the IC.
