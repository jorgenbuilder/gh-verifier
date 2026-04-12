#!/bin/bash
set -euo pipefail

echo "=== ICP Build Verifier ==="

# Check for required files
if [ ! -f "build-steps.json" ]; then
    echo "Error: build-steps.json not found. Run extract-build-steps.ts first."
    exit 1
fi

if [ ! -f "proposal.json" ]; then
    echo "Error: proposal.json not found. Run fetch-proposal.ts first."
    exit 1
fi

# Build profile detection (shell fallback if not in JSON)
detect_profile() {
    local normalized
    normalized=$(echo "$1" | sed 's/\.git$//' | sed 's:/$::')
    [ "$normalized" = "https://github.com/dfinity/ic" ] && echo "ic-monorepo" || echo "standard"
}

# Parse JSON files using node
COMMIT_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).commitHash)")
REPO_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).repoUrl)")
WASM_OUTPUT_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).wasmOutputPath)")
WASM_FILENAME=$(basename "$WASM_OUTPUT_PATH")

# Determine build profile
BUILD_PROFILE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).buildProfile || '')" 2>/dev/null)
[ -z "$BUILD_PROFILE" ] && BUILD_PROFILE=$(detect_profile "$REPO_URL")

echo "Repository: $REPO_URL"
echo "WASM filename: $WASM_FILENAME"
echo "Commit hash: $COMMIT_HASH"
echo "Expected WASM output: $WASM_OUTPUT_PATH"

# Clone repository
echo ""
echo "=== Cloning repository ==="
if [ -d "repo" ]; then
    echo "Removing existing repo directory..."
    rm -rf repo
fi

# Shallow clone, then fetch the specific commit
git clone --depth 1 "$REPO_URL" repo
cd repo

echo "Fetching commit $COMMIT_HASH..."
git fetch --depth 1 origin "$COMMIT_HASH"
git checkout "$COMMIT_HASH"

# Detect IC monorepo and resolve Bazel target
IS_IC_MONOREPO=false
BAZEL_TARGET=""

if [[ "$REPO_URL" == *"github.com/dfinity/ic"* ]]; then
    IS_IC_MONOREPO=true
    echo ""
    echo "=== Detected IC monorepo - attempting targeted Bazel build ==="

    BUILD_BAZEL="publish/canisters/BUILD.bazel"
    if [ -f "$BUILD_BAZEL" ]; then
        # Parse CANISTERS dict: "governance-canister.wasm.gz": "//rs/nns/governance:governance-canister"
        BAZEL_TARGET=$(grep -E "\"$WASM_FILENAME\"\s*:" "$BUILD_BAZEL" | \
            sed -E 's/.*"[^"]+"\s*:\s*"([^"]+)".*/\1/' | \
            head -1) || true

        if [ -n "$BAZEL_TARGET" ]; then
            echo "Found Bazel target: $BAZEL_TARGET"
        else
            echo "Could not find target for $WASM_FILENAME, will use full build"
        fi
    fi
fi

# Pigz upstream checksum fix (IC monorepo only)
# The pigz-2.8 tarball at zlib.net periodically changes contents, breaking the
# checksum that the Bazel Central Registry expects. Use archive_override to
# redirect the download to the stable GitHub mirror and supply the BCR patches.
if [ "$IS_IC_MONOREPO" = true ] && [ -f "MODULE.bazel" ]; then
    echo "Patching MODULE.bazel to use GitHub mirror for pigz..."
    PIGZ_PATCHES_DIR="$(pwd)/bazel/pigz_patches"
    mkdir -p "$PIGZ_PATCHES_DIR"

    # Download the BCR patches for pigz 2.8
    BCR_BASE="https://raw.githubusercontent.com/bazelbuild/bazel-central-registry/main/modules/pigz/2.8/patches"
    for patch in add_build_file.patch module_dot_bazel.patch pigz.c.patch; do
        curl -fsSL "$BCR_BASE/$patch" -o "$PIGZ_PATCHES_DIR/$patch"
    done

    # Download the GitHub tarball and compute its integrity hash
    PIGZ_TARBALL="/tmp/pigz-2.8-github.tar.gz"
    curl -fsSL "https://github.com/madler/pigz/archive/refs/tags/v2.8.tar.gz" -o "$PIGZ_TARBALL"
    PIGZ_INTEGRITY="sha256-$(openssl dgst -sha256 -binary "$PIGZ_TARBALL" | openssl base64 -A)"
    echo "  pigz GitHub tarball integrity: $PIGZ_INTEGRITY"

    # Inject archive_override after the bazel_dep for pigz
    node -e "
const fs = require('fs');
let content = fs.readFileSync('MODULE.bazel', 'utf8');
const override = \`
archive_override(
    module_name = \"pigz\",
    urls = [\"https://github.com/madler/pigz/archive/refs/tags/v2.8.tar.gz\"],
    integrity = \"${PIGZ_INTEGRITY}\",
    strip_prefix = \"pigz-2.8\",
    patches = [
        \"//bazel/pigz_patches:add_build_file.patch\",
        \"//bazel/pigz_patches:module_dot_bazel.patch\",
        \"//bazel/pigz_patches:pigz.c.patch\",
    ],
    patch_strip = 0,
)
\`;
content = content.replace(
    /(bazel_dep\\(name\\s*=\\s*\"pigz\"[^)]*\\))/,
    '\$1' + override
);
fs.writeFileSync('MODULE.bazel', content);
"

    # Create BUILD.bazel for the patches directory so Bazel can find them
    cat > "$PIGZ_PATCHES_DIR/BUILD.bazel" << 'PATCHEOF'
exports_files(glob(["*.patch"]))
PATCHEOF

    echo "  pigz override injected successfully"
fi

# Per-repo BuildKit handling
# The IC build container lacks the buildx plugin, so BuildKit fails by default.
# IC monorepo: disable BuildKit (uses Bazel, not docker build)
# exchange-rate-canister: needs BuildKit for --output flag, so install buildx
# Other repos: disable BuildKit as a safe default
if [[ "$REPO_URL" == *"dfinity/exchange-rate-canister"* ]]; then
    echo "Installing docker buildx plugin for BuildKit support..."
    mkdir -p /usr/local/lib/docker/cli-plugins
    BUILDX_VERSION="v0.20.1"
    curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" \
        -o /usr/local/lib/docker/cli-plugins/docker-buildx
    chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
    echo "Installed buildx ${BUILDX_VERSION}"
else
    echo "Patching docker-build scripts to disable BuildKit..."
    find . -name "docker-build" -type f -exec sed -i 's/export DOCKER_BUILDKIT=1/export DOCKER_BUILDKIT=0/g' {} \;
fi

# Docker-in-Docker volume mount fix
# When running inside a container (e.g. ic-build on GitHub Actions), the Docker
# daemon runs on the host. Volume mounts like -v "$(pwd):/app" resolve to a
# container-internal path that doesn't exist on the host, so the mount silently
# creates an empty directory. Fix: rewrite docker run -v commands to use
# docker create + docker cp instead.
echo "Patching Docker volume mounts for container-in-container compatibility..."
find . -name "*.sh" -type f | while read -r script; do
    if grep -qE 'docker run[^;|]*-v\s+["\x27]?\$(\(pwd\)|PWD):' "$script"; then
        echo "  Patching DinD volume mounts in: $script"
        node -e "
const fs = require('fs');
let content = fs.readFileSync('$script', 'utf8');
// Match: docker run [flags] -v \"\$(pwd):/path\" IMAGE CMD
// Rewrite to: docker create + docker cp + docker start + docker cp + docker rm
content = content.replace(
    /^(\s*)docker run\s+(.*?)-v\s+[\"']?\\\$\(pwd\):([^\s\"']+)[\"']?\s+(.*?)\s+(\S+)\s+(.+)$/mg,
    (match, indent, preFlags, mountPath, postFlags, image, cmd) => {
        // Remove --rm from flags since we need the container to persist for docker cp
        const flags = (preFlags + ' ' + postFlags).replace(/--rm/g, '').trim();
        const lines = [
            indent + '_GHV_CID=\$(docker create ' + (flags ? flags + ' ' : '') + image + ' ' + cmd + ')',
            indent + 'docker cp . \"\$_GHV_CID:' + mountPath + '\"',
            indent + 'docker start -a \"\$_GHV_CID\"',
            indent + '_GHV_RC=\$?',
            indent + 'docker cp \"\$_GHV_CID:' + mountPath + '/.\" .',
            indent + 'docker rm \"\$_GHV_CID\" >/dev/null',
            indent + '[ \$_GHV_RC -eq 0 ] || exit \$_GHV_RC',
        ];
        return lines.join('\n');
    }
);
fs.writeFileSync('$script', content);
"
    fi
done

echo ""
echo "=== Running build steps ==="

# Helper function to setup builder user (bazel's rules_python requires non-root)
setup_builder_user() {
    if [ "$(id -u)" = "0" ]; then
        echo "Running as root, creating build user for bazel..."
        useradd -m -s /bin/bash builder 2>/dev/null || true
        chown -R builder:builder .
        mkdir -p /home/builder/.cache
        chown -R builder:builder /home/builder
        if [ -S /var/run/docker.sock ]; then
            echo "Granting builder user access to Docker socket..."
            DOCKER_SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
            echo "Docker socket GID: $DOCKER_SOCKET_GID"
            groupadd -g "$DOCKER_SOCKET_GID" -f docker 2>/dev/null || true
            usermod -aG "$DOCKER_SOCKET_GID" builder 2>/dev/null || true
        fi
        return 0
    fi
    return 1
}

TARGETED_BUILD_SUCCESS=false

# Try targeted Bazel build if we have a target
if [ -n "$BAZEL_TARGET" ]; then
    echo ""
    echo "=== TARGETED Bazel build: $BAZEL_TARGET ==="

    if [ -n "${BAZEL_REMOTE_CACHE_URL:-}" ] && [ -n "${BAZEL_REMOTE_CACHE_TOKEN:-}" ]; then
        echo "Remote cache enabled"
        CACHE_BAZELRC="/tmp/remote-cache.bazelrc"
        cat > "$CACHE_BAZELRC" << CACHEEOF
build --remote_cache=$BAZEL_REMOTE_CACHE_URL
build "--remote_header=Authorization=Bearer $BAZEL_REMOTE_CACHE_TOKEN"
build --remote_upload_local_results=true
build --experimental_remote_downloader=
build --experimental_remote_cache_compression=false
CACHEEOF
        chmod 644 "$CACHE_BAZELRC"
        BAZEL_CMD="bazel --bazelrc=$CACHE_BAZELRC build --config=stamped $BAZEL_TARGET"
    else
        # No cache configured; use --config=local to disable DFINITY's unreachable internal cache
        BAZEL_CMD="bazel build --config=local --config=stamped $BAZEL_TARGET"
    fi

    if setup_builder_user; then
        echo ">>> Executing (as builder): $BAZEL_CMD"
        if su - builder -c "cd $(pwd) && $BAZEL_CMD"; then
            TARGETED_BUILD_SUCCESS=true
        fi
    else
        echo ">>> Executing: $BAZEL_CMD"
        if eval "$BAZEL_CMD"; then
            TARGETED_BUILD_SUCCESS=true
        fi
    fi

    if [ "$TARGETED_BUILD_SUCCESS" = false ]; then
        echo "Targeted build failed, falling back to full build..."
    fi
fi

# Fallback to full build
if [ "$TARGETED_BUILD_SUCCESS" = false ]; then
    echo ""
    echo "=== Running full build ==="

    # Read build steps
    STEPS=$(node -e "JSON.parse(require('fs').readFileSync('../build-steps.json')).steps.forEach(s => console.log(s))")

    if [ "$IS_IC_MONOREPO" = true ]; then
        # IC monorepo: create marker file to prevent nested container spawning
        # The IC build scripts check for /home/ubuntu/.ic-build-container to detect
        # if they're already running inside the ic-build container
        mkdir -p /home/ubuntu
        touch /home/ubuntu/.ic-build-container
        echo "Created /home/ubuntu/.ic-build-container marker file"

        if setup_builder_user; then
            # Execute each step as builder user (bazel's rules_python requires non-root)
            while IFS= read -r step; do
                if [ -n "$step" ]; then
                    echo ""
                    echo ">>> Executing (as builder): $step"
                    su - builder -c "cd $(pwd) && export DOCKER_BUILDKIT=0 DFINITY_CONTAINER=${DFINITY_CONTAINER:-} && $step" || {
                        echo "Warning: Build command returned non-zero exit code: $?"
                        echo "Checking if build artifacts were produced anyway..."
                    }
                fi
            done <<< "$STEPS"
        else
            # Execute each step with IC-specific env vars
            while IFS= read -r step; do
                if [ -n "$step" ]; then
                    echo ""
                    echo ">>> Executing: $step"
                    export DOCKER_BUILDKIT=0 DFINITY_CONTAINER=${DFINITY_CONTAINER:-} && eval "$step"
                fi
            done <<< "$STEPS"
        fi
    else
        # Standard repos: run steps directly in the same shell so that
        # environment variables (e.g. export IP_SUPPORT=ipv4) persist
        # across steps. No builder user or IC marker file needed.
        while IFS= read -r step; do
            if [ -n "$step" ]; then
                echo ""
                echo ">>> Executing: $step"
                eval "$step"
            fi
        done <<< "$STEPS"
    fi
fi

echo ""
echo "=== Build complete ==="

# Copy output WASM to known location
mkdir -p ../output

if [ "$TARGETED_BUILD_SUCCESS" = true ]; then
    # Derive bazel-bin path: //rs/nns/governance:governance-canister -> bazel-bin/rs/nns/governance/governance-canister.wasm.gz
    BAZEL_PACKAGE=$(echo "$BAZEL_TARGET" | sed 's|^//||' | sed 's|:.*||')
    BAZEL_TARGET_NAME=$(echo "$BAZEL_TARGET" | sed 's|.*:||')
    BAZEL_OUTPUT="bazel-bin/$BAZEL_PACKAGE/${BAZEL_TARGET_NAME}.wasm.gz"

    echo "Looking for Bazel output at: $BAZEL_OUTPUT"

    if [ -f "$BAZEL_OUTPUT" ]; then
        cp "$BAZEL_OUTPUT" ../output/canister.wasm
        echo "Copied Bazel output to ../output/canister.wasm"
    else
        echo "Expected Bazel output not found, searching bazel-bin for $WASM_FILENAME..."
        FOUND=$(find bazel-bin -name "$WASM_FILENAME" -type f 2>/dev/null | head -1)
        if [ -n "$FOUND" ]; then
            cp "$FOUND" ../output/canister.wasm
            echo "Copied $FOUND to ../output/canister.wasm"
        else
            echo "Error: Could not find $WASM_FILENAME in bazel-bin"
            exit 1
        fi
    fi
else
    # Original full build output path
    if [ -f "$WASM_OUTPUT_PATH" ]; then
        cp "$WASM_OUTPUT_PATH" ../output/canister.wasm
        echo "Copied WASM to ../output/canister.wasm"
    else
        echo "Warning: Expected WASM not found at $WASM_OUTPUT_PATH"
        echo "Searching for .wasm files..."
        find . -name "*.wasm" -type f 2>/dev/null | head -20
        exit 1
    fi
fi

cd ..
echo ""
echo "=== Build verification ready ==="
ls -la output/

# Explicitly exit with success code
exit 0
