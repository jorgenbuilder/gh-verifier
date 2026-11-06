# Fix notes: proposal #144742 verify failure

## Root cause

Not a build failure. Verify run 42224783263 died in step 2 ("Extract build steps via
LLM") before anything was cloned or built: Gemini returned `402 Payment Required ...
Your prepayment credits are depleted` (`RESOURCE_EXHAUSTED`). The auto-fix loop then
classified it as a build failure, spent a Claude run, correctly produced no code change,
and opened issue #7. So "auto fix failed" was really "there was no code to fix".

## Fix

- `src/extract-build-steps.ts` now parses the build instructions deterministically from
  the proposal's own `Wasm Verification` code block (repo, build steps, `sha256sum`
  output path) and its `didc encode` / `Upgrade Arguments` block (args, `-d`, `-t`).
  This covers every standard DFINITY template (IC monorepo, cycles ledger, XRC, Bitcoin,
  Dogecoin). No LLM is involved for those; it also removes an LLM trust assumption.
- Only an unrecognised summary falls back to an LLM, now Claude via the existing
  `CLAUDE_CODE_OAUTH_TOKEN` (headless `claude -p`). Gemini and `@google/genai` are gone.
- `auto-fix.yml` triage now classifies third-party billing/auth errors (402,
  `RESOURCE_EXHAUSTED`, low credit balance, missing token) as `infra`: it alerts a human
  instead of running a pointless code auto-fix.

Hash comparison (`compare-hash.ts`) and the on-chain expected hashes are untouched.
