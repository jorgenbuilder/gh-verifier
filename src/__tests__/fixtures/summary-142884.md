# Upgrade the Engine-controller Canister to Commit e9963e1

__Proposer__: pietro.di.marco at dfinity.org

__Source code__: [e9963e1c5852e407327d04fcccfc1fd8ad50d948][new-commit]

[new-commit]: https://github.com/dfinity/ic/tree/e9963e1c5852e407327d04fcccfc1fd8ad50d948


## Features & Fixes

###  Changed

* `update_subnet` no longer forces the engine controller's authorized caller
  (super admin) into the `subnet_admins` list. The supplied list is now
  forwarded to the registry as-is.

* `create_engine` no longer forces the engine controller's authorized caller
  (super admin) into the `subnet_admins` list. The supplied list is now
  forwarded to the registry as-is.


## New Commits

```
$ git log --format="%C(auto) %h %s" dc7e68fd110b45ac534c1cdf402b4e4242fbd54d..e9963e1c5852e407327d04fcccfc1fd8ad50d948 --  ./rs/engine_controller
 a4c75fdcb4 fix: engine controller canister injecting caller to the subnet admins (#10779)
 24bd84899f feat: Cleanup remaining blessed version references (#10689)
```


## Upgrade Arguments

```candid
(opt record { authorized_caller = opt principal "q6cfj-fyaaa-aaaar-qb77q-cai"; initial_dkg_subnet_id = null })
```


## Current Version

__Current git hash__: dc7e68fd110b45ac534c1cdf402b4e4242fbd54d

__Current wasm hash__: f03b77a2534eca9314b3c6b2f7281cce0a2341bd4239690f648723cde9f7c006


## Verification

See the general instructions on [how to verify] proposals like this. A "quick
start" guide is provided here.

[how to verify]: https://github.com/dfinity/ic/tree/e9963e1c5852e407327d04fcccfc1fd8ad50d948/rs/nervous_system/docs/proposal_verification.md


### WASM Verification

See ["Building the code"][prereqs] for prerequisites.

[prereqs]: https://github.com/dfinity/ic/tree/e9963e1c5852e407327d04fcccfc1fd8ad50d948/README.adoc#building-the-code

```
# 1. Get a copy of the code.
git clone git@github.com:dfinity/ic.git
cd ic
# Or, if you already have a copy of the ic repo,
git fetch
git checkout e9963e1c5852e407327d04fcccfc1fd8ad50d948

# 2. Build canisters.
./ci/container/build-ic.sh -c

# 3. Fingerprint the result.
sha256sum ./artifacts/canisters/engine-controller-canister.wasm.gz
```

This should match `wasm_module_hash` field of this proposal.


### Upgrade Arguments Verification

[`didc`][latest-didc] is required.

[latest-didc]: https://github.com/dfinity/candid/releases/latest

```
didc encode '(opt record { authorized_caller = opt principal "q6cfj-fyaaa-aaaar-qb77q-cai"; initial_dkg_subnet_id = null })' | xxd -r -p | sha256sum

```

This should match the `arg_hash` field of this proposal.

