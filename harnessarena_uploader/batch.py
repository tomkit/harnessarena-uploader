from __future__ import annotations

import json
import os
import platform
import sqlite3
import sys
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ._version import __version__
from .helpers import _machine_id, _utcnow_iso
from .models import Harness, HarnessMeta, SessionMeta, UploadBatch
from .parsers import PARSERS


def _get_installed_cli_version(binary: str) -> Optional[str]:
    """Run `binary --version` and return the version string, or None if unavailable.

    This is a FALLBACK for harnesses that don't embed version in session data.
    The per-session version from history data is always preferred.
    """
    import subprocess
    try:
        r = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


# Map of harness → binary name for version detection fallback
_HARNESS_BINARIES = {
    Harness.CLAUDE: "claude",
    Harness.GEMINI: "gemini",
    Harness.CODEX: "codex",
    Harness.AGENT: "agent",
}

# Map of harness → provider
_HARNESS_PROVIDERS = {
    Harness.CLAUDE: "anthropic",
    Harness.GEMINI: "google",
    Harness.CODEX: "openai",
    Harness.AGENT: "cursor",
    Harness.OPENCODE: "opencode",
}


def _get_harness_version_from_history(harness: Harness) -> Optional[str]:
    """Extract CLI version from the harness's own session history data.

    This is the PREFERRED source — it reflects what was actually used,
    not what's currently installed.
    """
    try:
        if harness == Harness.CODEX:
            db_path = Path.home() / ".codex" / "state_5.sqlite"
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                row = db.execute(
                    "SELECT cli_version FROM threads ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                db.close()
                if row and row[0]:
                    return row[0]

        elif harness == Harness.OPENCODE:
            db_path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                row = db.execute(
                    "SELECT version FROM session ORDER BY time_created DESC LIMIT 1"
                ).fetchone()
                db.close()
                if row and row[0]:
                    return row[0]

        # Gemini, Claude, Cursor Agent don't embed version in session data
    except Exception:
        pass
    return None


def _get_session_date_range(harness: Harness) -> tuple[Optional[str], Optional[str]]:
    """Get (earliest, latest) session dates as YYYY-MM-DD for a harness.

    Used as a version proxy when the harness doesn't store CLI version in history.
    """
    timestamps: list[int] = []  # millisecond epoch timestamps
    dates_str: list[str] = []   # ISO date strings

    try:
        if harness == Harness.CLAUDE:
            sessions_dir = Path.home() / "Library" / "Application Support" / "Claude" / "claude-code-sessions"
            for f in sessions_dir.rglob("*.json"):
                try:
                    d = json.loads(f.read_text())
                    for key in ("createdAt", "lastActivityAt"):
                        ts = d.get(key)
                        if ts and isinstance(ts, (int, float)):
                            timestamps.append(int(ts))
                except Exception:
                    pass

        elif harness == Harness.GEMINI:
            for f in Path.home().joinpath(".gemini", "tmp").rglob("chats/*.json"):
                try:
                    d = json.loads(f.read_text())
                    for key in ("startTime", "lastUpdated"):
                        ts = d.get(key)
                        if ts and isinstance(ts, str) and len(ts) >= 10:
                            dates_str.append(ts[:10])
                except Exception:
                    pass

        elif harness == Harness.AGENT:
            for db_path in Path.home().joinpath(".cursor", "chats").rglob("store.db"):
                try:
                    db = sqlite3.connect(str(db_path))
                    meta_hex = db.execute("SELECT value FROM meta LIMIT 1").fetchone()[0]
                    meta = json.loads(bytes.fromhex(meta_hex))
                    ts = meta.get("createdAt")
                    if ts and isinstance(ts, (int, float)):
                        timestamps.append(int(ts))
                    db.close()
                except Exception:
                    pass

    except Exception:
        pass

    # Convert timestamps to date strings
    for ts in timestamps:
        dates_str.append(
            datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        )

    if not dates_str:
        return (None, None)

    return (min(dates_str), max(dates_str))


def _get_version_range_from_history(harness: Harness) -> Optional[str]:
    """For harnesses that store version per-session, return a range if versions differ.

    e.g. "0.39.0..0.117.0" if sessions span multiple CLI versions.
    """
    versions: list[str] = []
    try:
        if harness == Harness.CODEX:
            db_path = Path.home() / ".codex" / "state_5.sqlite"
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                rows = db.execute("SELECT DISTINCT cli_version FROM threads WHERE cli_version IS NOT NULL").fetchall()
                versions = sorted(set(r[0] for r in rows if r[0]))
                db.close()

        elif harness == Harness.OPENCODE:
            db_path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                rows = db.execute("SELECT DISTINCT version FROM session WHERE version IS NOT NULL").fetchall()
                versions = sorted(set(r[0] for r in rows if r[0]))
                db.close()
    except Exception:
        pass

    if not versions:
        return None
    if len(versions) == 1:
        return versions[0]
    # Sort by semver-ish: split on dots, compare numerically where possible
    def _version_key(v: str):
        parts = []
        for p in v.split("."):
            try:
                parts.append(int(p))
            except ValueError:
                parts.append(p)
        return parts
    versions.sort(key=_version_key)
    return f"{versions[0]}..{versions[-1]}"


def _collect_harness_meta(harness: Harness) -> HarnessMeta:
    """Collect metadata about a harness installation.

    Version resolution: history data first, installed binary fallback.
    Raises RuntimeError if version cannot be determined.
    """
    os_name = platform.system().lower()
    os_arch = platform.machine()
    shell = os.environ.get("SHELL", "").split("/")[-1] or "unknown"
    provider = _HARNESS_PROVIDERS[harness]
    source = "cli"
    default_model = None
    plugin_version = None

    # 1. Version range from history (preferred — reflects actual usage)
    cli_version = _get_version_range_from_history(harness)

    # 2. Fallback: use session date range as version proxy
    if not cli_version:
        earliest, latest = _get_session_date_range(harness)
        if earliest and latest and earliest != latest:
            cli_version = f"~{earliest}..{latest}"
        elif earliest:
            cli_version = f"~{earliest}"
        else:
            cli_version = "unknown"

    # 3. Harness-specific extras
    if harness == Harness.CODEX:
        try:
            db_path = Path.home() / ".codex" / "state_5.sqlite"
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                row = db.execute(
                    "SELECT model, source FROM threads ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                if row:
                    default_model = row[0]
                    source = row[1] or "cli"
                db.close()
        except Exception:
            pass

    elif harness == Harness.OPENCODE:
        try:
            pkg = Path.home() / ".config" / "opencode" / "package.json"
            if pkg.exists():
                data = json.loads(pkg.read_text())
                plugin_version = data.get("dependencies", {}).get("@opencode-ai/plugin")
        except Exception:
            pass

    if not cli_version:
        raise RuntimeError(
            f"Could not detect version for '{harness.value}' from history or installed binary."
        )

    return HarnessMeta(
        name=harness,
        cli_version=cli_version,
        os_name=os_name,
        os_arch=os_arch,
        shell=shell,
        source=source,
        default_model=default_model,
        provider=provider,
        plugin_version=plugin_version,
    )


def _apply_aliases(session: SessionMeta, aliases: dict[str, str]) -> SessionMeta:
    """Apply project name aliases to a session. Returns a new SessionMeta if renamed."""
    if not aliases or not session.project_name:
        return session
    new_name = aliases.get(session.project_name)
    if not new_name or new_name == session.project_name:
        return session
    # Frozen dataclass — rebuild with new project_name
    d = {f.name: getattr(session, f.name) for f in session.__dataclass_fields__.values()}
    d["project_name"] = new_name
    if d.get("git_repo_name") == session.project_name:
        d["git_repo_name"] = new_name
    return SessionMeta(**d)


def build_batch(
    harnesses: list[Harness],
    since: Optional[datetime] = None,
    project_aliases: Optional[dict[str, str]] = None,
) -> Optional[UploadBatch]:
    """Scan requested harnesses and build an UploadBatch."""
    all_sessions: list[SessionMeta] = []

    # Resolve versions first so parsers can use them
    harness_versions: dict[Harness, str] = {}
    harness_metas_list: list[HarnessMeta] = []
    for harness in harnesses:
        try:
            meta = _collect_harness_meta(harness)
            harness_versions[harness] = meta.cli_version
            harness_metas_list.append(meta)
        except RuntimeError as e:
            print(f"  {harness.value}: skipped ({e})", file=sys.stderr)
            continue

    for harness in harnesses:
        if harness not in harness_versions:
            continue
        parser = PARSERS.get(harness)
        if parser:
            sessions = parser.parse(since=since)
            # Fill in harness_version for sessions that don't have it
            patched = []
            for s in sessions:
                if not s.harness_version or not s.harness_version.strip():
                    # Replace with resolved version using frozen dataclass workaround
                    d = {f.name: getattr(s, f.name) for f in s.__dataclass_fields__.values()}
                    d["harness_version"] = harness_versions[harness]
                    patched.append(SessionMeta(**d))
                else:
                    patched.append(s)
            all_sessions.extend(patched)
            print(f"  {harness.value}: found {len(patched)} session(s)", file=sys.stderr)

    if not all_sessions:
        return None

    # Apply project name aliases
    if project_aliases:
        all_sessions = [_apply_aliases(s, project_aliases) for s in all_sessions]

    # Final validation: every session must have a harness_version after patching
    for s in all_sessions:
        if not s.harness_version:
            raise ValueError(
                f"Session {s.source_session_id} ({s.harness.value}) has no harness_version "
                f"after resolution. This is a bug."
            )

    harness_metas = tuple(harness_metas_list)

    return UploadBatch(
        id=str(uuid.uuid4()),
        tool_version=__version__,
        harnesses_scanned=tuple(harnesses),
        harness_meta=harness_metas,
        sessions=tuple(all_sessions),
        machine_id=_machine_id(),
        created_at=_utcnow_iso(),
    )


def serialize_batch(batch: UploadBatch) -> dict:
    """Convert batch to a JSON-serializable dict."""
    result = asdict(batch)
    # Convert Harness enums to strings
    result["harnesses_scanned"] = [h.value for h in batch.harnesses_scanned]
    for hm in result["harness_meta"]:
        hm["name"] = hm["name"] if isinstance(hm["name"], str) else hm["name"]
    for s in result["sessions"]:
        s["harness"] = s["harness"] if isinstance(s["harness"], str) else s["harness"]
    return result
