#!/bin/bash
# Load .env and run build-memory-v1.5.ts

set -a
source .env
set +a

pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts
