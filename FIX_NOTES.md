# Fix notes — proposal #144742 build failure

**Root cause (environment, not proposal).** Proposal #144742 builds `dfinity/cycles-ledger`
at commit `58f1d01` via `./scripts/docker-build`. That script runs
`DOCKER_BUILDKIT=1 docker build ... --output "$tmp_outdir"`. The `--output` flag is a
**BuildKit-only** feature, so the build inherently requires BuildKit and the `docker-buildx`
plugin — which the `ic-build` container does not ship. `scripts/build.sh` classified
cycles-ledger into its default branch, which tries to *disable* BuildKit by sed-replacing
`export DOCKER_BUILDKIT=1`. That never matched (the script uses an inline `DOCKER_BUILDKIT=1`
command prefix, not `export`), and even a successful patch would have failed because
`--output` cannot run without BuildKit. The job therefore errored with
"BuildKit is enabled but the buildx component is missing or broken."

**Fix.** Extended the existing per-repo BuildKit branch in `scripts/build.sh` — previously only
`exchange-rate-canister`, which has the identical `--output` requirement — to also match
`dfinity/cycles-ledger`, so buildx (pinned to `v0.20.1`) is installed for it instead of
BuildKit being (ineffectively) disabled. This is the minimal, surgical change in the style of
the surrounding code; it does not touch hash comparison or any verification logic. After the
fix the real `docker-build` runs unmodified and the produced `cycles-ledger.wasm.gz` is hashed
and compared against the on-chain payload as normal.
