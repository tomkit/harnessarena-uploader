from __future__ import annotations

import hashlib
import os
import platform
from datetime import datetime, timezone
from typing import Optional

from .models import Harness


def _make_session_id(harness: Harness, source_id: str) -> str:
    """Deterministic, non-reversible session ID for idempotent uploads."""
    return hashlib.sha256(f"{harness.value}:{source_id}".encode()).hexdigest()


def _machine_id() -> str:
    """Hash the hostname so we can correlate uploads per machine without
    leaking the actual hostname."""
    return hashlib.sha256(platform.node().encode()).hexdigest()


def _basename_only(path: Optional[str]) -> Optional[str]:
    """Strip a path to its final component. This is a privacy boundary —
    full paths must NEVER pass through."""
    if path is None:
        return None
    name = os.path.basename(path.rstrip("/\\"))
    return name if name else None


def _decode_claude_project_dir(encoded_name: str) -> Optional[str]:
    """Decode a Claude Code project directory name to the project basename.

    Claude encodes paths like: -Users-tomkit-Projects-angry-bird-clone
    The encoding replaces "/" with "-", but project names can also contain hyphens.
    We can't blindly replace all "-" with "/" — instead, find the last known
    path segment ("Projects", "Downloads", etc.) and take everything after it.
    """
    # Common parent dirs that appear in the encoded path
    known_parents = ["-Projects-", "-Downloads-", "-Documents-", "-Desktop-",
                     "-repos-", "-src-", "-code-", "-workspace-", "-work-"]
    for parent in known_parents:
        idx = encoded_name.rfind(parent)
        if idx >= 0:
            return encoded_name[idx + len(parent):]
    # Fallback: take the last segment after the last known separator
    # e.g. "-Users-tomkit-something" → "something" (unreliable but better than nothing)
    parts = encoded_name.strip("-").split("-")
    return parts[-1] if parts else None


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_int(val, default: int = 0) -> int:
    """Coerce to int, return default on failure."""
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _epoch_to_iso(val) -> str:
    """Convert a Unix epoch (seconds or milliseconds) to ISO 8601 UTC string.
    Returns empty string on failure."""
    if val is None:
        return ""
    try:
        ts = float(val)
        # Heuristic: if > 1e12, it's milliseconds
        if ts > 1e12:
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _parse_timestamp(val) -> str:
    """Parse a timestamp that could be ISO 8601, Unix epoch seconds, or
    Unix epoch milliseconds. Returns ISO 8601 UTC string or empty."""
    if val is None:
        return ""
    s = str(val)
    # Try ISO 8601 first
    if any(c in s for c in ("T", "-", ":")):
        try:
            datetime.fromisoformat(s.replace("Z", "+00:00"))
            return s
        except ValueError:
            pass
    # Try epoch
    return _epoch_to_iso(val)


_PROMPT_KEY_BUCKET_MS = 5000  # 5-second bucket for timestamp fuzzy matching


def _make_prompt_key(display_text: str, timestamp_ms: int) -> str:
    """Create a dedup key for a prompt from its display text and timestamp.

    Used to reconcile prompts between JSONL session files and history.jsonl.
    Both sources share the same prompt text but timestamps differ by a few ms,
    so we bucket to 5-second granularity for matching.
    """
    bucket = timestamp_ms // _PROMPT_KEY_BUCKET_MS
    return f"{display_text[:100]}|{bucket}"


def _extract_user_display_text(entry: dict) -> str:
    """Extract the first text block from a JSONL user entry.

    Skips tool_result entries (which have no human text).
    Only reads enough to build a dedup key — never stores full content.
    """
    msg = entry.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str):
        return content[:100]
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if text:
                    return text[:100]
    return ""
