import { describe, it, expect } from 'vitest';
import { IDL } from '@dfinity/candid';
import { createHash } from 'crypto';
import { legacyWasmHashFromPayload } from '../fetch-proposal.js';

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
