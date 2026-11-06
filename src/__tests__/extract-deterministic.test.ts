import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractDeterministic, parseDidcLine } from '../extract-build-steps.js';

const fixture = (id: number) =>
  readFileSync(join(__dirname, 'fixtures', `summary-${id}.md`), 'utf-8');

describe('extractDeterministic (real proposal summaries)', () => {
  it('cycles ledger (#144742)', () => {
    expect(extractDeterministic(fixture(144742))).toEqual({
      repoUrl: 'https://github.com/dfinity/cycles-ledger',
      steps: ['"./scripts/docker-build"'],
      wasmOutputPath: 'cycles-ledger.wasm.gz',
      upgradeArgs: '()',
      upgradeArgsDid: null,
      upgradeArgsType: null,
    });
  });

  it('bitcoin canister with didc -d/-t (#144665)', () => {
    expect(extractDeterministic(fixture(144665))).toEqual({
      repoUrl: 'https://github.com/dfinity/bitcoin-canister',
      steps: ['"./scripts/docker-build" "ic-btc-canister"'],
      wasmOutputPath: 'ic-btc-canister.wasm.gz',
      upgradeArgs: '(variant { upgrade })',
      upgradeArgsDid: 'canister/candid.did',
      upgradeArgsType: '(canister_arg)',
    });
  });

  it('XRC with env-prefixed build step (#142800)', () => {
    const r = extractDeterministic(fixture(142800));
    expect(r?.repoUrl).toBe('https://github.com/dfinity/exchange-rate-canister');
    expect(r?.steps).toEqual(['IP_SUPPORT="ipv4" "./scripts/docker-build"']);
    expect(r?.wasmOutputPath).toBe('xrc.wasm.gz');
    expect(r?.upgradeArgs).toBe('()');
  });

  it('IC monorepo with upgrade args (#142884)', () => {
    expect(extractDeterministic(fixture(142884))).toEqual({
      repoUrl: 'https://github.com/dfinity/ic',
      steps: ['./ci/container/build-ic.sh -c'],
      wasmOutputPath: 'artifacts/canisters/engine-controller-canister.wasm.gz',
      upgradeArgs:
        '(opt record { authorized_caller = opt principal "q6cfj-fyaaa-aaaar-qb77q-cai"; initial_dkg_subnet_id = null })',
      upgradeArgsDid: null,
      upgradeArgsType: null,
    });
  });

  it('IC monorepo without upgrade args (#142453)', () => {
    const r = extractDeterministic(fixture(142453));
    expect(r?.repoUrl).toBe('https://github.com/dfinity/ic');
    expect(r?.wasmOutputPath).toBe('artifacts/canisters/registry-canister.wasm.gz');
    expect(r?.upgradeArgs).toBeNull();
  });

  it('returns null for an unrecognised summary (LLM fallback)', () => {
    expect(extractDeterministic('# Something\n\nNo build instructions here.')).toBeNull();
  });
});

describe('parseDidcLine', () => {
  it('plain args', () => {
    expect(parseDidcLine("didc encode '()' | xxd -r -p | sha256sum")).toEqual({ args: '()', did: null, type: null });
  });
  it('type without value is rejected', () => {
    expect(parseDidcLine("didc encode -t '(canister_arg)'")).toBeNull();
  });
});
