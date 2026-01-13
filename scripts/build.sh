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

# Parse JSON files using node
COMMIT_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).commitHash)")
REPO_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).repoUrl)")
WASM_OUTPUT_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).wasmOutputPath)")

echo "Repository: $REPO_URL"
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

echo ""
echo "=== Running build steps ==="

# Read build steps
STEPS=$(node -e "JSON.parse(require('fs').readFileSync('../build-steps.json')).steps.forEach(s => console.log(s))")

# If running as root, create a non-root user and run bazel as that user
# (rules_python requires non-root for hermetic Python)
if [ "$(id -u)" = "0" ]; then
    echo "Running as root, creating build user for bazel..."
    useradd -m -s /bin/bash builder 2>/dev/null || true

    # Give builder ownership of the ic directory
    chown -R builder:builder .

    # Create bazel cache directory for builder
    mkdir -p /home/builder/.cache
    chown -R builder:builder /home/builder

    # Execute each step as builder user
    while IFS= read -r step; do
        if [ -n "$step" ]; then
            echo ""
            echo ">>> Executing (as builder): $step"
            su - builder -c "cd $(pwd) && DOCKER_BUILDKIT=0 $step"
        fi
    done <<< "$STEPS"
else
    # Execute each step normally
    while IFS= read -r step; do
        if [ -n "$step" ]; then
            echo ""
            echo ">>> Executing: $step"
            DOCKER_BUILDKIT=0 eval "$step"
        fi
    done <<< "$STEPS"
fi

echo ""
echo "=== Build complete ==="

# Copy output WASM to known location
mkdir -p ../output

if [ -f "$WASM_OUTPUT_PATH" ]; then
    cp "$WASM_OUTPUT_PATH" ../output/canister.wasm
    echo "Copied WASM to ../output/canister.wasm"
else
    echo "Warning: Expected WASM not found at $WASM_OUTPUT_PATH"
    echo "Searching for .wasm files..."
    find . -name "*.wasm" -type f 2>/dev/null | head -20
    exit 1
fi

cd ..
echo ""
echo "=== Build verification ready ==="
ls -la output/
