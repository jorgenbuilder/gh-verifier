# Upgrade the Registry Canister to Commit bfd76b5

__Proposer__: daniel.wong at dfinity.org

__Source code__: [bfd76b534ba5297714a19b3af6589a576cf24225][new-commit]

[new-commit]: https://github.com/dfinity/ic/tree/bfd76b534ba5297714a19b3af6589a576cf24225


## Features & Fixes

###  Changed

* Temporarily bypass the per-operator `max_rewardable_nodes` quota check in
  `add_node` for node reward types `type4.1` through `type4.4`. Instead of the
  configured quota, these types are subjected to a single high sentinel cap
  (`EXCESSIVE_NUMBER_OF_TYPE_4_NODES`, currently 1000 per node operator),
  chosen to be well above any realistic per-operator deployment while still
  preventing runaway registrations. `type4.5` is explicitly excluded and
  remains subject to the standard `max_rewardable_nodes` quota.

  Motivation: node providers are starting to deploy gen4 hardware now, but the
  reward canister currently still treats `type4.5` rewards as `type1.1`, which
  means we cannot yet meaningfully size `max_rewardable_nodes` quotas for the
  `type4.x` family. Enforcing the quota in the meantime would block legitimate
  gen4 onboarding. The quota check will be restored once the reward-side
  handling of `type4.5` is fixed (see CLO-15).


## New Commits

```
$ git log --format="%C(auto) %h %s" 8facd5635c5e05de9b423b64aeabc2e1ad58d66e..bfd76b534ba5297714a19b3af6589a576cf24225 --  ./rs/registry/canister
 a764289863 feat: allow unlimited number of gen4 nodes (#10448)
```


## Current Version

__Current git hash__: 8facd5635c5e05de9b423b64aeabc2e1ad58d66e

__Current wasm hash__: 10029d6fc8c8dd5e75e370e32da22a40453897135903d1d87414fc7af61ba717


## Verification

See the general instructions on [how to verify] proposals like this. A "quick
start" guide is provided here.

[how to verify]: https://github.com/dfinity/ic/tree/bfd76b534ba5297714a19b3af6589a576cf24225/rs/nervous_system/docs/proposal_verification.md


### WASM Verification

See ["Building the code"][prereqs] for prerequisites.

[prereqs]: https://github.com/dfinity/ic/tree/bfd76b534ba5297714a19b3af6589a576cf24225/README.adoc#building-the-code

```
# 1. Get a copy of the code.
git clone git@github.com:dfinity/ic.git
cd ic
# Or, if you already have a copy of the ic repo,
git fetch
git checkout bfd76b534ba5297714a19b3af6589a576cf24225

# 2. Build canisters.
./ci/container/build-ic.sh -c

# 3. Fingerprint the result.
sha256sum ./artifacts/canisters/registry-canister.wasm.gz
```

This should match `wasm_module_hash` field of this proposal.

