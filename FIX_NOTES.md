# Fix notes — proposal #144199 build failure

## Root cause

The run failed in the build/environment stage at **"Build WASM"**, before any hash
comparison, so this is a verifier-pipeline problem, not a bad proposal. In
`scripts/build.sh` the "Resolving abbreviated commit 98c898f to full SHA..." step hit
`curl: (22) The requested URL returned error: 422`, and the empty body piped into
`node -e "JSON.parse(...)"` then died with `SyntaxError: Unexpected end of JSON input`,
failing the job (`set -euo pipefail`).

The deeper cause is in `src/fetch-proposal.ts`. `extractCommitHash` anchored on the
first `commit`-labelled token, which for this proposal is the **abbreviated** hash in
the *title* ("Upgrade the Registry Canister to Commit 98c898f") — so `commitHash` was
stored as the 7-char `98c898f`. build.sh shallow-clones and must then `git fetch origin
<sha>`, which the smart-HTTP protocol only accepts as a full 40-char SHA, so it first
tries to expand the short hash via the GitHub API. But dfinity/ic's public mirror
returns `422 "No commit found for SHA"` for the `98c898f` prefix even though the full
commit exists and resolves fine (`.../commits/98c898f8de068a1fc0e97ebc805f9fa7f315d862`
→ HTTP 200). GitHub's abbreviated-SHA resolution on the public mirror is simply not
dependable, and the pipeline had no working fallback. The full 40-char SHA is present
throughout the proposal *body* (the "Source code" link and the `git checkout <sha>`
verification command); we just weren't selecting it.

## Fix

Reordered `extractCommitHash` to **prefer a full 40-char SHA** (the first standalone
40-char hex token in title+summary+url — the new source commit, which precedes the
later "Current git hash") and only fall back to the abbreviated `commit`-labelled form
when no full SHA is present anywhere. This yields `98c898f8de068a1fc0e97ebc805f9fa7f315d862`,
which resolves on GitHub and is directly fetchable — build.sh's `^[0-9a-f]{40}$` guard
now passes, so the flaky API-resolution step is skipped entirely and `git fetch origin
<full-sha>` succeeds. Verified end-to-end: re-fetching proposal #144199 now stores the
full SHA, the full SHA returns HTTP 200 while `98c898f` still 422s, and all 36 unit
tests pass (including the existing abbreviated-only fallback case).

This is a pure environment/extraction fix. It does not touch `src/compare-hash.ts`, the
matching rules, or the on-chain-derived expected hashes, and nothing about what counts
as a match changed — the verifier can still fail. It only makes the verifier fetch the
exact commit the proposal already points at so the build can reach a real hash
comparison against the on-chain payload.
