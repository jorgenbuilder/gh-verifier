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
