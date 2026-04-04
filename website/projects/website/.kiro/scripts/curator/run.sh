#!/bin/bash
# Load .env and run build-memory.ts

set -a
source .env
set +a

pnpm tsx .kiro/scripts/curator/build-memory.ts
