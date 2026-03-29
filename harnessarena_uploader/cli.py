from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

from ._version import __version__
from .batch import build_batch, serialize_batch
from .models import Harness
from .upload import upload_batch


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract metadata from AI coding harness sessions and upload to harnessarena.com",
        epilog="Privacy: This tool NEVER reads or transmits message content, code, or file paths.",
    )
    parser.add_argument(
        "--harness",
        choices=["claude", "gemini", "codex", "agent", "opencode", "all"],
        default="all",
        help="Which harness to scan (default: all)",
    )
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="Only include sessions after this date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Extract and print metadata without uploading",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.environ.get("HARNESSARENA_API_KEY"),
        help="API key for harnessarena.com (or set HARNESSARENA_API_KEY env var)",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default=os.environ.get("HARNESSARENA_API_URL", "https://harnessarena.com"),
        help="API base URL (default: https://harnessarena.com)",
    )
    parser.add_argument(
        "--alias",
        action="append",
        metavar="OLD=NEW",
        default=[],
        help="Rename a project in output (e.g. --alias speeding-ticket-fighter=ticketfight-ai). Can repeat.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"harnessarena-uploader {__version__}",
    )

    args = parser.parse_args()

    # Parse aliases
    project_aliases: dict[str, str] = {}
    for alias_str in args.alias:
        if "=" not in alias_str:
            parser.error(f"Invalid alias format '{alias_str}', expected OLD=NEW")
        old, new = alias_str.split("=", 1)
        project_aliases[old.strip()] = new.strip()

    # Resolve harnesses
    if args.harness == "all":
        harnesses = list(Harness)
    else:
        harnesses = [Harness(args.harness)]

    # Parse --since
    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            print(f"Error: --since must be YYYY-MM-DD, got '{args.since}'", file=sys.stderr)
            return 1

    print(f"harnessarena-uploader v{__version__}", file=sys.stderr)
    print(f"Scanning: {', '.join(h.value for h in harnesses)}", file=sys.stderr)

    batch = build_batch(harnesses, since=since, project_aliases=project_aliases)

    if batch is None:
        print("No sessions found.", file=sys.stderr)
        return 0

    print(f"\nBatch {batch.id}:", file=sys.stderr)
    print(f"  Sessions: {batch.session_count}", file=sys.stderr)
    print(f"  Total tokens: {batch.total_tokens:,}", file=sys.stderr)

    if args.dry_run:
        print("\n--- DRY RUN: payload below ---\n", file=sys.stderr)
        print(json.dumps(serialize_batch(batch), indent=2, default=str))
        return 0

    # Upload
    if not args.api_key:
        print(
            "Error: --api-key required (or set HARNESSARENA_API_KEY env var)",
            file=sys.stderr,
        )
        return 1

    success = upload_batch(batch, args.api_url, args.api_key)
    return 0 if success else 1
