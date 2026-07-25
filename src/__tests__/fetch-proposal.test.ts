import { describe, it, expect } from 'vitest';
import { IDL } from '@dfinity/candid';
import { createHash } from 'crypto';
import { legacyWasmHashFromPayload, extractCommitHash } from '../fetch-proposal.js';

describe('extractCommitHash', () => {
  it('picks the labelled commit even when a wasm-hash fragment is nearby', () => {
    // Real shape of proposal #143107's summary: an abbreviated commit alongside
    // the short form of the 64-char wasm hash. The commit must win.
    const summary =
      'Reinstall the canister with the currently deployed wasm ' +
      '(unchanged hash d7b1cde1, commit 6590c85f) to clear its heap state.';
    expect(extractCommitHash(summary)).toBe('6590c85f');
  });

  it('still matches a standalone full 40-char commit hash', () => {
    const text = 'Built from a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 of dfinity/ic';
    expect(extractCommitHash(text)).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('returns null when no commit is present', () => {
    expect(extractCommitHash('No source reference here.')).toBeNull();
  });
});

describe('legacyWasmHashFromPayload', () => {
  it('extracts and hashes wasm_module from a multi-field legacy payload', () => {
    // \0asm + version — a minimal wasm header is enough; we only hash the bytes.
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    // Mirror AddNnsCanisterProposalPayload's shape (extra fields around the one
    // we care about) to prove candid record subtyping skips the rest.
    const FullPayload = IDL.Record({
      name: IDL.Text,
      wasm_module: IDL.Vec(IDL.Nat8),
      arg: IDL.Vec(IDL.Nat8),
      compute_allocation: IDL.Opt(IDL.Nat),
      initial_cycles: IDL.Nat64,
    });
    const encoded = IDL.encode(
      [FullPayload],
      [
        {
          name: 'engine-controller',
          wasm_module: Array.from(wasm),
          arg: [],
          compute_allocation: [],
          initial_cycles: 1n,
        },
      ]
    );
    const payload = Array.from(new Uint8Array(encoded));

    const expected = createHash('sha256').update(wasm).digest('hex');
    expect(legacyWasmHashFromPayload(payload)).toBe(expected);
  });

  it('throws on a payload with no wasm_module field', () => {
    const NoWasm = IDL.Record({ name: IDL.Text });
    const encoded = IDL.encode([NoWasm], [{ name: 'nope' }]);
    const payload = Array.from(new Uint8Array(encoded));
    expect(() => legacyWasmHashFromPayload(payload)).toThrow();
  });
});
