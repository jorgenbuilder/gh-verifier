# Fix notes — proposal #143258 build failure

## Root cause

The run failed in the build/environment stage at **"Build WASM"** with
`fatal: couldn't find remote ref fc79106` — before any hash comparison, so this is a
verifier-pipeline problem, not a bad proposal.

Proposal #143258's summary references its source as an **abbreviated** 7-character
commit (`Upgrade the Migration Canister to Commit fc79106`), and `extractCommitHash`
(`src/fetch-proposal.ts`) legitimately passes that short hash through — a behavior
deliberately introduced by the previous auto-repair (#143107), whose note reasoned
"git resolves abbreviated hashes at checkout, so a 7+ char prefix is sufficient."

That reasoning holds for `git checkout` against a populated local object database, but
`scripts/build.sh` does `git clone --depth 1` (default branch only) followed by
`git fetch --depth 1 origin fc79106`. `git fetch origin <sha>` cannot take a short
hash: the smart-HTTP protocol only accepts a full 40-char SHA in a "want" line and
treats anything shorter as a ref name — which doesn't exist — so the fetch aborts. The
shallow clone also never pulled the object locally, so there was nothing to expand.
Proposals that happened to quote a full 40-char hash worked; this is the first short-hash
one to reach the fetch step.

## Fix

In `scripts/build.sh`, immediately before the fetch, if `COMMIT_HASH` is not already a
full 40-char SHA, resolve it to the full SHA via the GitHub API for the same repo
(`GET /repos/<owner>/<repo>/commits/<short>` → `.sha`) and fetch that. Verified live: the
API expands `fc79106` → `fc79106bd7662b690ccfce113ce66008fb17eb0a`. The request uses
`GITHUB_TOKEN` only if present (unauthenticated access works for the public dfinity/ic
repo), and if resolution fails it falls back to fetching the hash as-is, preserving prior
behavior.

This is a pure environment fix: it still fetches, builds, and hashes the exact commit the
on-chain proposal points at. It does not touch `src/compare-hash.ts`, the matching rules,
or the on-chain-derived expected hashes, so verification strength is unchanged.
