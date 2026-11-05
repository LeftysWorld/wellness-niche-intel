#!/usr/bin/env bash
# Everything that must pass before a commit or deploy (CI runs the same steps).
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
npx tsc -p tsconfig.functions.json
if command -v deno >/dev/null; then deno check supabase/functions/api/index.ts; fi
echo "Also run scripts/sql_tests.sql against the project after any migration."
