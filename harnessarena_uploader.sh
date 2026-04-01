#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node was not found in PATH. Install Node.js 22+ to continue." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# If running from a local checkout (dist/cli.js exists), use it directly
if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund --silent 2>/dev/null)
  fi
  exec node "$SCRIPT_DIR/dist/cli.js" "$@"
fi

# Otherwise, clone into a temp dir (for curl | bash one-liner usage)
REPO_URL="https://github.com/harnessarena/uploader.git"

TMP_DIR="$(mktemp -d -t harnessarena_uploader.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

git clone --depth 1 --quiet "$REPO_URL" "$TMP_DIR"
(cd "$TMP_DIR" && npm install --no-audit --no-fund --silent 2>/dev/null)
exec node "$TMP_DIR/dist/cli.js" "$@"
