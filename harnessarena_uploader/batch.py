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
from .history_paths import (
    get_claude_history_paths,
    get_codex_history_paths,
    get_cursor_history_paths,
    get_gemini_history_paths,
    get_opencode_history_paths,
)
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
            db_path = get_codex_history_paths().state_db_path
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                row = db.execute(
                    "SELECT cli_version FROM threads ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                db.close()
                if row and row[0]:
                    return row[0]

        elif harness == Harness.OPENCODE:
            db_path = get_opencode_history_paths().db_path
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
            sessions_dir = get_claude_history_paths().app_sessions_dir
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
            for f in get_gemini_history_paths().tmp_dir.rglob("chats/*.json"):
                try:
                    d = json.loads(f.read_text())
                    for key in ("startTime", "lastUpdated"):
                        ts = d.get(key)
                        if ts and isinstance(ts, str) and len(ts) >= 10:
                            dates_str.append(ts[:10])
                except Exception:
                    pass

        elif harness == Harness.AGENT:
            for db_path in get_cursor_history_paths().chats_dir.rglob("store.db"):
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
            db_path = get_codex_history_paths().state_db_path
            if db_path.exists():
                db = sqlite3.connect(str(db_path))
                rows = db.execute("SELECT DISTINCT cli_version FROM threads WHERE cli_version IS NOT NULL").fetchall()
                versions = sorted(set(r[0] for r in rows if r[0]))
                db.close()

        elif harness == Harness.OPENCODE:
            db_path = get_opencode_history_paths().db_path
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
            db_path = get_codex_history_paths().state_db_path
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
            pkg = get_opencode_history_paths().package_json_path
            if pkg.exists():
                data = json.loads(pkg.read_text())
                plugin_version = data.get("dependencies", {}).get("@opencode-ai/plugin")
        except Exception:
            pass

    if not cli_version:
        raise RuntimeError(
            f"Could not detect version for '{harness.value}' from history or installed binary."
        )

    # Collect available inventory
    available_tools, available_skills, available_mcp_servers, available_agents = _collect_harness_inventory(harness)

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
        available_tools=available_tools,
        available_skills=available_skills,
        available_mcp_servers=available_mcp_servers,
        available_agents=available_agents,
    )


def _read_skill_metadata(skill_dir: Path) -> dict:
    """Read metadata from a skill's SKILL.md frontmatter. Never reads skill content."""
    meta: dict = {"name": skill_dir.name}
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return meta
    try:
        in_front = False
        for line in skill_md.read_text(encoding="utf-8").splitlines()[:30]:
            stripped = line.strip()
            if stripped == "---":
                if in_front:
                    break
                in_front = True
                continue
            if in_front and ":" in stripped:
                key, _, val = stripped.partition(":")
                key = key.strip().lower()
                val = val.strip().strip('"').strip("'")
                if key == "description" and val and not val.endswith("|"):
                    meta["description"] = val[:200]
                elif key == "version" and val:
                    meta["version"] = val
                elif key == "author" and val:
                    meta["author"] = val
                    # Detect marketplace from author
                    if val.lower() == "vercel":
                        meta["marketplace"] = "vercel-labs"
        # Install date from directory creation time
        try:
            import stat as stat_mod
            st = skill_dir.stat()
            created = datetime.fromtimestamp(st.st_birthtime, tz=timezone.utc)
            meta["installed_at"] = created.strftime("%Y-%m-%d")
        except (AttributeError, OSError):
            pass
    except OSError:
        pass
    return meta


def _read_plugin_metadata(plugin_name: str, marketplace_slug: str = "claude-plugins-official") -> dict:
    """Read metadata from a marketplace plugin's plugin.json cache."""
    meta: dict = {"name": plugin_name, "marketplace": marketplace_slug}
    cache_dir = Path.home() / ".claude" / "plugins" / "cache" / marketplace_slug / plugin_name
    if not cache_dir.is_dir():
        return meta
    # Find any version's plugin.json (prefer newest)
    for version_dir in sorted(cache_dir.iterdir(), reverse=True):
        for plugin_dir_name in (".claude-plugin", ".cursor-plugin"):
            pj = version_dir / plugin_dir_name / "plugin.json"
            if pj.is_file():
                try:
                    data = json.loads(pj.read_text())
                    if data.get("description"):
                        meta["description"] = data["description"][:200]
                    if data.get("version"):
                        meta["version"] = data["version"]
                    if data.get("homepage"):
                        meta["url"] = data["homepage"]
                    elif data.get("repository"):
                        meta["url"] = data["repository"]
                    author = data.get("author", {})
                    if isinstance(author, dict) and author.get("name"):
                        meta["author"] = author["name"]
                    elif isinstance(author, str):
                        meta["author"] = author
                except (json.JSONDecodeError, OSError):
                    pass
                return meta
    return meta


# Canonical native tool descriptions per harness
_CLAUDE_TOOLS = {
    "Read": "Read file contents", "Write": "Write/create files", "Edit": "Edit with string replacement",
    "Bash": "Execute shell commands", "Glob": "Find files by pattern", "Grep": "Search file contents",
    "WebSearch": "Search the web", "WebFetch": "Fetch and process web content",
    "Agent": "Spawn subagent for complex tasks", "Skill": "Load specialized skill instructions",
    "ToolSearch": "Search for deferred tools", "EnterPlanMode": "Enter analysis-only mode",
    "ExitPlanMode": "Exit plan mode", "TaskCreate": "Create a task", "TaskUpdate": "Update task status",
    "TaskGet": "Get task details", "TaskList": "List all tasks", "NotebookEdit": "Edit Jupyter notebooks",
    "LSP": "Language Server Protocol queries", "AskUserQuestion": "Ask the user a question",
}
_CLAUDE_AGENTS = {
    "general-purpose": "General-purpose agent for multi-step tasks",
    "Explore": "Fast agent for codebase exploration and search",
    "Plan": "Software architect agent for designing implementation plans",
}
_GEMINI_TOOLS = {
    "glob": "Find files by pattern", "grep_search": "Search file contents", "list_directory": "List directory",
    "read_file": "Read file contents", "run_shell_command": "Execute shell commands",
    "write_file": "Write files", "replace": "Replace text in files", "google_web_search": "Search the web",
    "web_fetch": "Fetch web content", "read_many_files": "Read multiple files", "memory": "Store/recall facts",
    "activate_skill": "Load a skill", "ask_user": "Ask the user", "enter_plan_mode": "Enter plan mode",
    "exit_plan_mode": "Exit plan mode", "write_todos": "Write todo list", "get_internal_docs": "Get internal docs",
    "update_topic": "Update conversation topic",
    "tracker_create_task": "Create tracker task", "tracker_update_task": "Update tracker task",
    "tracker_get_task": "Get tracker task", "tracker_list_tasks": "List tracker tasks",
    "tracker_add_dependency": "Add task dependency", "tracker_visualize": "Visualize tasks",
}
_GEMINI_AGENTS = {
    "generalist": "General-purpose subagent for diverse tasks",
    "cli_help": "CLI documentation and help agent",
    "codebase_investigator": "Deep codebase analysis agent",
}
_CODEX_TOOLS = {
    "exec_command": "Execute commands", "shell": "Shell access", "write_stdin": "Write to stdin",
    "update_plan": "Update execution plan", "tool_suggest": "Suggest tools",
    "list_mcp_resources": "List MCP resources", "list_mcp_resource_templates": "List MCP templates",
}
_CODEX_AGENTS = {"spawn_agent": "Spawn a collaborative subagent", "wait_agent": "Wait for subagent completion"}
_OPENCODE_TOOLS = {
    "bash": "Execute shell commands", "edit": "Edit files", "glob": "Find files",
    "read": "Read files", "write": "Write files", "question": "Ask the user",
    "todowrite": "Write todo items", "skill": "Load a skill", "task": "Spawn a subagent task",
}
_CURSOR_TOOLS = {
    "Read": "Read files", "Write": "Write files", "Edit": "Edit files", "Shell": "Execute commands",
    "Glob": "Find files", "Grep": "Search contents", "LS": "List directory",
    "StrReplace": "String replacement", "ReadLints": "Read lint results",
    "WebSearch": "Search the web", "Task": "Create task",
}


def _collect_harness_inventory(
    harness: Harness,
) -> tuple[tuple, tuple, tuple, tuple]:
    """Collect available tools, skills, MCP servers, and agent types with metadata."""
    tools: list[dict] = []
    skills: list[dict] = []
    mcp_servers: list[dict] = []
    agents: list[dict] = []

    try:
        if harness == Harness.CLAUDE:
            tools = [{"name": n, "description": d} for n, d in sorted(_CLAUDE_TOOLS.items())]
            agents = [{"name": n, "description": d} for n, d in sorted(_CLAUDE_AGENTS.items())]
            claude_home = get_claude_history_paths().home
            # Custom skills from ~/.claude/skills/
            skills_dir = claude_home / "skills"
            seen_skills: set[str] = set()
            if skills_dir.is_dir():
                for d in sorted(skills_dir.iterdir()):
                    if d.is_dir():
                        skills.append(_read_skill_metadata(d))
                        seen_skills.add(d.name)
            # Marketplace plugins from settings + plugin cache
            settings_file = claude_home / "settings.json"
            if settings_file.is_file():
                try:
                    data = json.loads(settings_file.read_text())
                    for pid in (data.get("enabledPlugins") or {}):
                        base = pid.split("@")[0]
                        if base and base not in seen_skills:
                            skills.append(_read_plugin_metadata(base))
                            seen_skills.add(base)
                except (json.JSONDecodeError, OSError):
                    pass

        elif harness == Harness.GEMINI:
            tools = [{"name": n, "description": d} for n, d in sorted(_GEMINI_TOOLS.items())]
            agents = [{"name": n, "description": d} for n, d in sorted(_GEMINI_AGENTS.items())]
            seen_skills: set[str] = set()
            for skills_dir in [get_gemini_history_paths().skills_dir, get_gemini_history_paths().agents_skills_dir]:
                if skills_dir.is_dir():
                    for d in sorted(skills_dir.iterdir()):
                        if d.is_dir() and d.name not in seen_skills:
                            skills.append(_read_skill_metadata(d))
                            seen_skills.add(d.name)

        elif harness == Harness.CODEX:
            tools = [{"name": n, "description": d} for n, d in sorted(_CODEX_TOOLS.items())]
            agents = [{"name": n, "description": d} for n, d in sorted(_CODEX_AGENTS.items())]
            paths = get_codex_history_paths()
            if paths.config_path.is_file():
                try:
                    for line in paths.config_path.read_text().splitlines():
                        line = line.strip()
                        if line.startswith("[plugins."):
                            name = line.split('"')[1] if '"' in line else ""
                            base = name.split("@")[0]
                            if base:
                                skills.append({"name": base})
                except OSError:
                    pass

        elif harness == Harness.OPENCODE:
            tools = [{"name": n, "description": d} for n, d in sorted(_OPENCODE_TOOLS.items())]
            skills_dir = Path.home() / ".claude" / "skills"
            if skills_dir.is_dir():
                for d in sorted(skills_dir.iterdir()):
                    if d.is_dir():
                        skills.append(_read_skill_metadata(d))

        elif harness == Harness.AGENT:
            tools = [{"name": n, "description": d} for n, d in sorted(_CURSOR_TOOLS.items())]

    except Exception:
        pass

    return (tuple(tools), tuple(skills), tuple(mcp_servers), tuple(agents))


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


def list_projects(batch: UploadBatch) -> list[tuple[str, tuple[Harness, ...], int]]:
    """Return unique projects in a batch with harness coverage and session counts."""
    projects: dict[str, dict[str, object]] = {}
    for session in batch.sessions:
        if not session.project_name:
            continue
        entry = projects.setdefault(
            session.project_name,
            {"harnesses": set(), "session_count": 0},
        )
        harnesses = entry["harnesses"]
        if isinstance(harnesses, set):
            harnesses.add(session.harness)
        entry["session_count"] = int(entry["session_count"]) + 1

    rows: list[tuple[str, tuple[Harness, ...], int]] = []
    for project_name, entry in sorted(projects.items()):
        harnesses = tuple(sorted(entry["harnesses"], key=lambda h: h.value))
        session_count = int(entry["session_count"])
        rows.append((project_name, harnesses, session_count))
    return rows
