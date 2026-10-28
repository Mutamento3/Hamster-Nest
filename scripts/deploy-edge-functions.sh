#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"

# Retry the failed function only; never hide a compile/configuration error.
for release_directory in supabase/functions/*/; do
  [[ -f "${release_directory}index.ts" ]] || continue
  release_function=$(basename "$release_directory")
  [[ "$release_function" != _* ]] || continue
  for release_attempt in 1 2 3; do
    if release_output=$(supabase functions deploy "$release_function" --use-api --project-ref "$SUPABASE_PROJECT_REF" 2>&1); then
      printf '%s\n' "$release_output"
      break
    else
      release_status=$?
    fi
    printf '%s\n' "$release_output"
    if [[ "$release_attempt" -eq 3 ]] || [[ "$release_output" != *"Bundle generation timed out"* && "$release_output" != *"body timed out"* ]]; then
      exit "$release_status"
    fi
    printf 'Transient bundling timeout for %s; retry %s/3\n' "$release_function" "$((release_attempt + 1))"
    sleep 5
  done
done
