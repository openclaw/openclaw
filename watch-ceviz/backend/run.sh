#!/usr/bin/env bash

set -e

PORT=${1:-8080}
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Starting Watch Ceviz backend stub on port $PORT..."
python3 "$DIR/main.py" "$PORT"