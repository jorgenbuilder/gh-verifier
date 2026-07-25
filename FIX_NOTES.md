# Fix notes — proposal #143107 build failure

## Root cause

The run failed in the build/environment stage at **"Extract build steps via LLM"**
with `No commit hash found in proposal. Cannot proceed with build.` This is a
verifier-pipeline problem, not a bad proposal — no hash comparison was ever
reached.

The upstream proposal-summary format drifted. `src/fetch-proposal.ts`'s
`extractCommitHash` only matched a **full 40-char** git hash
(`/\b([a-f0-9]{40})\b/`). Proposal #143107's summary references its source as an
**abbreviated** hash — `"...unchanged hash d7b1cde1, commit 6590c85f..."` — so the
regex matched nothing, `commitHash` stayed `null`, and the downstream
`extract-build-steps.ts` guard aborted the build. (In `fetch-proposal` itself the
missing commit was only a warning; the fatal exit happened one step later.)

## Fix

Anchor extraction on the explicit `commit` keyword and accept an abbreviated
(7–40 char) hash: `/\bcommit[:\s]+([a-f0-9]{7,40})\b/i`, falling back to the
original standalone full-40-char match for older summaries. Keying on the
`commit` label is deliberate — the same summary also contains `hash d7b1cde1` (the
short form of the 64-char on-chain **wasm** hash), and a naive "any short hex"
regex would have grabbed that instead. git resolves abbreviated hashes at
checkout, so a 7+ char prefix is sufficient to build. This only broadens *which
commit string is recognized*; it does not touch hash comparison, matching rules,
or the on-chain-derived `expectedWasmHash`, so verification strength is unchanged.

`extractCommitHash` is now exported and covered by three tests
(`src/__tests__/fetch-proposal.test.ts`), including the exact wasm-hash-decoy case
from #143107. Verified against live proposal #143107: `Source Commit: 6590c85f`.
Full suite: 36 passing.
