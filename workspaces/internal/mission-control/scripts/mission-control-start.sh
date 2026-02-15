#!/usr/bin/env bash
set -euo pipefail

cd /Users/popstack/.openclaw/workspace/mission-control

export NODE_ENV=production

NPM="/opt/homebrew/bin/npm"

# Ensure dependencies are present (LaunchAgents sometimes start before your shell env is loaded).
if [ ! -d node_modules ]; then
  "$NPM" ci
fi

# Ensure we have a production build.
if [ ! -d .next ]; then
  "$NPM" run build
fi

# Bind only on localhost; Caddy publishes it on LAN at /mission-control.
exec ./node_modules/.bin/next start -p 3000 -H 127.0.0.1
