# Fix notes — proposal #143579 verification failure

## Root cause: stale code, not a live bug

Run [31825900758](https://github.com/jorgenbuilder/gh-verifier/actions/runs/31825900758)
failed at **"Build WASM"** with the same
`Error in archive_override: multiple overrides for dep pigz found` described in the
#143577 notes below — Bazel aborted while evaluating `MODULE.bazel`, before any hash
comparison, so this was a verifier-pipeline failure rather than a bad proposal.

The pigz guard that fixes exactly this had **already been written** (commit `065f5da`,
authored 17:52:39Z). The #143579 run was dispatched at 17:51:02Z and checked out
`a77d35a` — the commit *before* the guard. The two overlapped by under two minutes, so
the run built with pre-fix code and re-injected the duplicate override.

Confirmation that the guard itself is sound: proposal #143577 targets the *same*
upstream commit `8aa4680e378f3248e7e7b9b8237915aded999bd9`, ran on `065f5da`, and
verified green. Checking `dfinity/ic` at that commit, `MODULE.bazel:67` does declare
`module_name = "pigz"`, which the guard matches — so injection is correctly skipped.

**Resolution:** re-dispatched verification for #143579 against `main`. No behavioral fix
to the guard was required.

## Hardening: regression cover for the guard

This failure mode — a `scripts/build.sh` workaround that is correct for older commits but
becomes *harmful* once upstream adopts its own fix — has now cost two verification runs
and had no test coverage. The guard was an inline `grep` chain inside a 400-line shell
script, so nothing could exercise it.

The predicates now live in `scripts/lib/pigz-guard.sh` as two functions,
`pigz_needs_injection` and `pigz_has_repo_override`, which `build.sh` sources and calls.
`src/__tests__/pigz-guard.test.ts` runs those real shell functions (not a
reimplementation) against `MODULE.bazel` fixtures taken from both upstream shapes: `8aa4680`
(upstream override present → defer) and `fe7d1fd` (no override → inject). It also covers
whitespace variants, non-`archive_override` override forms, an override of an unrelated
module, and a missing `MODULE.bazel`.

The refactor is behavior-preserving: the matching semantics are unchanged apart from
using POSIX `[[:space:]]` instead of the GNU-only `\s`, and the guard was re-checked
against both real upstream files before and after the change.

---

# Fix notes — proposal #143577 build failure

## Root cause

The run failed in the build/environment stage at **"Build WASM"** with
`Error in archive_override: multiple overrides for dep pigz found` while Bazel
evaluated the IC repo's `MODULE.bazel` — before any hash comparison, so this is a
verifier-pipeline problem, not a bad proposal.

`scripts/build.sh` carries a workaround that injects an `archive_override` for the
`pigz` Bazel module to mirror the periodically-drifting `zlib.net` tarball. At this
proposal's commit `8aa4680e378f3248e7e7b9b8237915aded999bd9`, upstream `dfinity/ic`
now ships its **own** `archive_override` for `pigz` (pointing at the
`distfiles.macports.org` mirror, with the same integrity
`sha256-64crTw4fDr5Zyfe9jFBsQgSJO6aoSS3jHfQW8NUXD9A=` our script independently derived
from the Bazel Central Registry). Upstream fixed the exact problem our workaround was
built for. Our injection then added a **second** override for the same module, and
Bazel refuses to evaluate a module with two overrides — failing both the targeted and
the fallback full build. This is moving-upstream-reference drift: the workaround was
correct for older commits but became redundant (and now harmful) once upstream adopted
its own mirror.

## Fix

In `scripts/build.sh`, made the pigz mirror injection conditional on the repo not
already declaring its own `pigz` override. The guard now additionally requires that no
`module_name = "pigz"` line (any `*_override`) exists in `MODULE.bazel` before
injecting; when the repo already provides one, the script logs that it is deferring to
the repo's own override and skips injection. Verified via the upstream `MODULE.bazel`
at `8aa4680` that the repo's own override supplies a working mirror URL and the correct
integrity, so deferring to it produces the same fetch our workaround intended. The
workaround still fires for older commits that lack an upstream override, so verification
of earlier proposals is unaffected.

This is a pure environment fix. It does not touch `src/compare-hash.ts`, the matching
rules, or the on-chain-derived expected hashes, and nothing about what counts as a match
changed — the verifier can still fail. With the duplicate override removed, Bazel can
evaluate `MODULE.bazel` and the governance-canister build can proceed to a real hash
comparison against the on-chain payload.
