#!/bin/bash
# Guard predicates for the pigz mirror workaround in scripts/build.sh.
#
# Background: the BCR `pigz` module fetches its source tarball from zlib.net,
# whose pigz-2.8 tarball periodically changes bytes and breaks the integrity
# hash. build.sh works around that by injecting its own `archive_override` with
# a mirror URL.
#
# That workaround is only safe while upstream does NOT ship an override of its
# own. The IC monorepo now carries its own `archive_override(module_name =
# "pigz", ...)` pointing at distfiles.macports.org. Bazel rejects a module with
# two overrides for the same dep ("multiple overrides for dep pigz found"),
# which fails the build before any hash comparison happens.
#
# These predicates are kept in their own file so they can be exercised directly
# by the test suite against real MODULE.bazel fixtures.

# True (0) when MODULE.bazel declares an override for pigz itself, in which
# case build.sh must defer to it rather than adding a second one.
#
# Matches any *_override form (archive_override, single_version_override, ...)
# since Bazel counts all of them toward the one-override-per-dep limit.
pigz_has_repo_override() {
    local module_file="$1"
    [ -f "$module_file" ] || return 1
    grep -qE 'module_name[[:space:]]*=[[:space:]]*"pigz"' "$module_file"
}

# True (0) when build.sh should inject its own pigz mirror override: the repo
# depends on pigz but has not overridden it.
pigz_needs_injection() {
    local module_file="$1"
    [ -f "$module_file" ] || return 1
    grep -q 'bazel_dep(name = "pigz"' "$module_file" || return 1
    ! pigz_has_repo_override "$module_file"
}
