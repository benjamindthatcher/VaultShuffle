#!/bin/sh
# Commits and pushes the work that was finished but could not be committed,
# because git could not open .git/config from the agent's shell.
set -e
cd "$(dirname "$0")/.."
git add -A
git commit -F .vaultshuffle-pending/commit-message.txt
git push origin main
echo
echo "Pushed. You can delete .vaultshuffle-pending once this is done."
