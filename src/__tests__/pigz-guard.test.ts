import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises the real shell predicates in scripts/lib/pigz-guard.sh (the ones
// scripts/build.sh actually calls), rather than reimplementing their logic.
//
// Regression cover for proposal #143579, where build.sh injected a second
// `archive_override` for pigz on a commit where the IC monorepo had started
// shipping its own. Bazel aborted with "multiple overrides for dep pigz found"
// before any hash comparison, failing verification for pipeline reasons rather
// than because the proposal was bad.

const GUARD_LIB = resolve(__dirname, '../../scripts/lib/pigz-guard.sh');

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'pigz-guard-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Runs one predicate from the guard lib, returning its exit status as a boolean. */
function runPredicate(fn: 'pigz_needs_injection' | 'pigz_has_repo_override', contents: string | null): boolean {
  const moduleFile = join(workdir, `MODULE.${Math.random().toString(36).slice(2)}.bazel`);
  if (contents !== null) writeFileSync(moduleFile, contents);

  const out = execFileSync(
    'bash',
    ['-c', `set -euo pipefail; . "$1"; if ${fn} "$2"; then echo true; else echo false; fi`, '_', GUARD_LIB, moduleFile],
    { encoding: 'utf8' },
  ).trim();

  return out === 'true';
}

// Real shape from dfinity/ic at 8aa4680 (proposals #143577 / #143579): upstream
// carries its own archive_override pointing at a macports mirror.
const UPSTREAM_WITH_OVERRIDE = `bazel_dep(name = "pigz", version = "2.8.bcr.1")  # (parallel) gzip

# The BCR \`pigz\` module fetches its source tarball from https://zlib.net, which
# is currently down. Override it to fetch it from a mirror.
archive_override(
    module_name = "pigz",
    integrity = "sha256-64crTw4fDr5Zyfe9jFBsQgSJO6aoSS3jHfQW8NUXD9A=",
    patch_strip = 0,
    strip_prefix = "pigz-2.8",
    urls = ["https://distfiles.macports.org/pigz/pigz-2.8.tar.gz"],
)

bazel_dep(name = "zstd", version = "1.5.7.bcr.1")
`;

// Real shape from dfinity/ic at fe7d1fd (proposal #139995): plain dependency,
// no override — the case the mirror workaround exists for.
const UPSTREAM_WITHOUT_OVERRIDE = `bazel_dep(name = "pigz", version = "2.8")  # (parallel) gzip

bazel_dep(name = "zstd", version = "1.5.7.bcr.1")
`;

describe('pigz_needs_injection', () => {
  it('defers to the repo when it already declares its own pigz override', () => {
    // The #143579 failure: injecting here produces a duplicate override.
    expect(runPredicate('pigz_needs_injection', UPSTREAM_WITH_OVERRIDE)).toBe(false);
  });

  it('injects the mirror when the repo depends on pigz without overriding it', () => {
    expect(runPredicate('pigz_needs_injection', UPSTREAM_WITHOUT_OVERRIDE)).toBe(true);
  });

  it('does not inject when the repo does not depend on pigz at all', () => {
    expect(runPredicate('pigz_needs_injection', 'bazel_dep(name = "zstd", version = "1.5.7.bcr.1")\n')).toBe(false);
  });

  it('does not inject when MODULE.bazel is absent (non-Bazel repo)', () => {
    expect(runPredicate('pigz_needs_injection', null)).toBe(false);
  });

  it('defers regardless of whitespace around the module_name assignment', () => {
    for (const decl of ['module_name="pigz"', 'module_name  =  "pigz"', '\tmodule_name = "pigz"']) {
      const contents = `bazel_dep(name = "pigz", version = "2.8")\narchive_override(\n    ${decl},\n)\n`;
      expect(runPredicate('pigz_needs_injection', contents)).toBe(false);
    }
  });

  it('defers for any override form, not just archive_override', () => {
    // Bazel counts every *_override toward the one-per-dep limit.
    const contents = `bazel_dep(name = "pigz", version = "2.8")\nsingle_version_override(\n    module_name = "pigz",\n    patch_strip = 1,\n)\n`;
    expect(runPredicate('pigz_needs_injection', contents)).toBe(false);
  });

  it('is not confused by an override of a different module', () => {
    const contents = `bazel_dep(name = "pigz", version = "2.8")\narchive_override(\n    module_name = "rules_foreign_cc",\n)\n`;
    expect(runPredicate('pigz_needs_injection', contents)).toBe(true);
  });
});

describe('pigz_has_repo_override', () => {
  it('detects the repo-supplied override', () => {
    expect(runPredicate('pigz_has_repo_override', UPSTREAM_WITH_OVERRIDE)).toBe(true);
  });

  it('reports none when the repo only declares the dependency', () => {
    expect(runPredicate('pigz_has_repo_override', UPSTREAM_WITHOUT_OVERRIDE)).toBe(false);
  });

  it('reports none when MODULE.bazel is absent', () => {
    expect(runPredicate('pigz_has_repo_override', null)).toBe(false);
  });
});
