# Fix Notes — proposal #142265 build failure

**Root cause.** The build failed in Bazel analysis with `cc_binary ... This rule has
been removed from Bazel. Please add a load() statement for it` and
`no such target '@@pigz+//:pigz'`. This is a verifier environment bug, not a bad
proposal — it never reached a hash comparison. `scripts/build.sh` injects an
`archive_override` for the `pigz` Bazel module (to work around the periodically
changing `zlib.net` tarball checksum), and it sourced that module's `source.json`
and BCR patches from a **hardcoded** path: `modules/pigz/2.8`. But the IC repo at
commit `8facd56` actually pins `bazel_dep(name = "pigz", version = "2.8.bcr.1")`.
The `2.8.bcr.1` BCR revision is the Bazel-9-compatible one: its `add_build_file.patch`
prepends `load("@rules_cc//cc:defs.bzl", "cc_binary")` and its `module_dot_bazel.patch`
adds `bazel_dep(name = "rules_cc", ...)`. The plain `2.8` revision the verifier was
pulling uses the bare native `cc_binary`, which Bazel 9.1.1 (the version the repo
pins in `.bazelversion`) has removed. By overriding with the stale `2.8` patches, the
verifier was clobbering the repo's intended `2.8.bcr.1` revision and reintroducing the
removed rule, so analysis aborted before any WASM was produced.

**Fix.** Make the pigz override use the exact module revision the repo pins instead of
a hardcoded one. `scripts/build.sh` now extracts the pinned version from the
`bazel_dep(name = "pigz", version = "...")` line in `MODULE.bazel` and uses it to build
the BCR module URL for both `source.json` and the patches (`modules/pigz/<version>`).
For this proposal that resolves to `2.8.bcr.1`, whose patches carry the `rules_cc`
`load()` statement, so the pigz `BUILD.bazel` is accepted by Bazel 9 and the build can
proceed to the hash comparison. The change is confined to the override-construction
block; the hash-comparison logic and what counts as a match are untouched. The fix is
also more robust generally — future pigz bumps in the IC repo are tracked automatically
rather than drifting against a frozen `2.8`.
