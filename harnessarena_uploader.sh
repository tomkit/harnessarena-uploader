#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tomkit/harnessarena-uploader.git"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Error: neither python3 nor python was found in PATH." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t harnessarena_uploader.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

git clone --depth 1 --quiet "$REPO_URL" "$TMP_DIR"
PYTHONPATH="$TMP_DIR" exec "$PYTHON_BIN" -m harnessarena_uploader "$@"
