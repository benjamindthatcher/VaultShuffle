#!/usr/bin/env bash
set -euo pipefail

input_prefix="${1:-/private/tmp/vaultshuffle-hltb-normalized-input}"
output_prefix="${2:-/private/tmp/vaultshuffle-hltb-normalized-result}"
shard_count="${3:-16}"
retry_mode="${4:-normalized}"

case "$retry_mode" in
  normalized) retry_flag="--normalized-retry" ;;
  edition) retry_flag="--edition-retry" ;;
  igdb-alias) retry_flag="--igdb-alias-retry" ;;
  *) echo "Retry mode must be 'normalized', 'edition', or 'igdb-alias'." >&2; exit 2 ;;
esac

pids=()
for ((shard = 1; shard <= shard_count; shard += 1)); do
  label="$(printf '%02d' "$shard")"
  python3 scripts/durations/enrich-hltb.py \
    --input "${input_prefix}-${label}-of-${shard_count}.json" \
    --output "${output_prefix}-${label}-of-${shard_count}.json" \
    --limit 1000000 \
    --delay 0.05 \
    "$retry_flag" \
    --resume \
    > "${output_prefix}-${label}-of-${shard_count}.log" 2>&1 &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    failed=1
  fi
done

exit "$failed"
