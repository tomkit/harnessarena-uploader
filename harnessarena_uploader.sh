#!/usr/bin/env bash
set -euo pipefail

PY_URL="https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.py"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Error: neither python3 nor python was found in PATH." >&2
  exit 1
fi

TMP_PY="$(mktemp -t harnessarena_uploader.XXXXXX.py)"
cleanup() {
  rm -f "$TMP_PY"
}
trap cleanup EXIT

curl -fsSL "$PY_URL" -o "$TMP_PY"
exec "$PYTHON_BIN" "$TMP_PY" "$@"
