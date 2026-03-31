#!/bin/bash

# Apple Silicon Optimizations Verification Script
# This script verifies that all Apple Silicon optimizations are properly implemented

set -e

echo "=========================================="
echo "Apple Silicon Optimizations Verification"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counter for tests
PASSED=0
FAILED=0

# Function to check if a file exists
check_file_exists() {
    local file=$1
    local description=$2
    
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $description"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} $description"
        FAILED=$((FAILED + 1))
    fi
}

# Function to check if a file contains a string
check_file_contains() {
    local file=$1
    local pattern=$2
    local description=$3
    
    if grep -q "$pattern" "$file"; then
        echo -e "${GREEN}✓${NC} $description"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} $description"
        FAILED=$((FAILED + 1))
    fi
}

# Function to check if a file compiles without errors
check_syntax() {
    local file=$1
    local description=$2
    
    if node --check "$file" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $description"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} $description"
        FAILED=$((FAILED + 1))
    fi
}

echo "1. Checking new files..."
echo "----------------------------------------"
check_file_exists "src/utils/platform.ts" "Platform utilities module exists"
check_file_exists "src/utils/platform.test.ts" "Unit tests for platform utilities exist"
check_file_exists "docs/apple-silicon-optimizations.md" "Documentation exists"

echo ""
echo "2. Checking modified files..."
echo "----------------------------------------"
check_file_exists "src/process/exec.ts" "Process exec module exists"
check_file_exists "src/agents/shell-utils.ts" "Shell utilities module exists"
check_file_exists "src/process/kill-tree.ts" "Kill tree module exists"

echo ""
echo "3. Checking Apple Silicon imports..."
echo "----------------------------------------"
check_file_contains "src/process/exec.ts" "isAppleSilicon" "exec.ts imports isAppleSilicon"
check_file_contains "src/process/exec.ts" "getOptimalBufferSize" "exec.ts imports getOptimalBufferSize"
check_file_contains "src/agents/shell-utils.ts" "isAppleSilicon" "shell-utils.ts imports isAppleSilicon"
check_file_contains "src/process/kill-tree.ts" "isAppleSilicon" "kill-tree.ts imports isAppleSilicon"

echo ""
echo "4. Checking Apple Silicon constants..."
echo "----------------------------------------"
check_file_contains "src/process/exec.ts" "IS_APPLE_SILICON = isAppleSilicon()" "exec.ts defines IS_APPLE_SILICON constant"
check_file_contains "src/process/exec.ts" "OPTIMAL_BUFFER_SIZE = getOptimalBufferSize()" "exec.ts defines OPTIMAL_BUFFER_SIZE constant"
check_file_contains "src/agents/shell-utils.ts" "IS_APPLE_SILICON = isAppleSilicon()" "shell-utils.ts defines IS_APPLE_SILICON constant"
check_file_contains "src/process/kill-tree.ts" "IS_APPLE_SILICON = isAppleSilicon()" "kill-tree.ts defines IS_APPLE_SILICON constant"

echo ""
echo "5. Checking Apple Silicon optimizations in exec.ts..."
echo "----------------------------------------"
check_file_contains "src/process/exec.ts" "maxBuffer: opts.maxBuffer ?? OPTIMAL_BUFFER_SIZE" "exec.ts uses optimized buffer size"
check_file_contains "src/process/exec.ts" "if (IS_APPLE_SILICON)" "exec.ts checks for Apple Silicon"

echo ""
echo "6. Checking Apple Silicon optimizations in shell-utils.ts..."
echo "----------------------------------------"
check_file_contains "src/agents/shell-utils.ts" "process.platform === \"darwin\" && IS_APPLE_SILICON" "shell-utils.ts checks for Apple Silicon macOS"
check_file_contains "src/agents/shell-utils.ts" "resolveShellFromPath(\"zsh\")" "shell-utils.ts prefers zsh on Apple Silicon"

echo ""
echo "7. Checking Apple Silicon optimizations in kill-tree.ts..."
echo "----------------------------------------"
check_file_contains "src/process/kill-tree.ts" "killProcessTreeUnix(pid, graceMs, IS_APPLE_SILICON)" "kill-tree.ts passes Apple Silicon flag"
check_file_contains "src/process/kill-tree.ts" "useProcessGroup = isAppleSilicon !== false" "kill-tree.ts uses process group optimization"

echo ""
echo "8. Checking syntax of modified files..."
echo "----------------------------------------"
check_syntax "src/utils/platform.ts" "Platform utilities compiles without errors"
check_syntax "src/process/exec.ts" "Process exec compiles without errors"
check_syntax "src/agents/shell-utils.ts" "Shell utilities compiles without errors"
check_syntax "src/process/kill-tree.ts" "Kill tree compiles without errors"

echo ""
echo "9. Checking documentation..."
echo "----------------------------------------"
check_file_exists "APPLE_SILICON_OPTIMIZATIONS.md" "Implementation summary exists"
check_file_exists "APPLE_SILICON_README.md" "User README exists"
check_file_exists "CHANGES_SUMMARY.md" "Changes summary exists"

echo ""
echo "=========================================="
echo "Verification Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some checks failed${NC}"
    exit 1
fi
