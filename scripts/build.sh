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
WASM_OUTPUT_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('build-steps.json')).wasmOutputPath)")

echo "Commit hash: $COMMIT_HASH"
echo "Expected WASM output: $WASM_OUTPUT_PATH"

# Clone dfinity/ic repository
echo ""
echo "=== Cloning dfinity/ic repository ==="
if [ -d "ic" ]; then
    echo "Removing existing ic directory..."
    rm -rf ic
fi

# Shallow clone, then fetch the specific commit
git clone --depth 1 https://github.com/dfinity/ic.git ic
cd ic

echo "Fetching commit $COMMIT_HASH..."
git fetch --depth 1 origin "$COMMIT_HASH"
git checkout "$COMMIT_HASH"

echo ""
echo "=== Running build steps ==="

# Read and execute build steps
STEPS=$(node -e "JSON.parse(require('fs').readFileSync('../build-steps.json')).steps.forEach(s => console.log(s))")

# Execute each step
while IFS= read -r step; do
    if [ -n "$step" ]; then
        echo ""
        echo ">>> Executing: $step"
        eval "$step"
    fi
done <<< "$STEPS"

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
