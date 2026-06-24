#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1

export PATH="/Users/benthatcher/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"

URL="http://localhost:8766"

echo "Starting Vault Shuffle Next.js app..."
echo "Open $URL"
(sleep 2; open "$URL") &

pnpm dev
