#!/usr/bin/env python3
"""
harnessarena-uploader: Extract metadata (never content) from local AI coding
harness chat histories and upload to harnessarena.com.

Supported harnesses:
  - Claude Code    (claude)   — JSONL sessions
  - Gemini CLI     (gemini)   — JSON sessions
  - Codex          (codex)    — SQLite + JSONL
  - Cursor Agent   (agent)    — SQLite with hex-encoded JSON
  - OpenCode       (opencode) — SQLite (Drizzle ORM)

Privacy guarantee: This script NEVER reads, stores, or transmits message
content, file contents, code, API keys, tool call arguments, or full file
paths. Only aggregated metadata (counts, durations, model names, token totals)
leaves the machine. The entire tool is a single file so users can audit it.

Usage:
    python harnessarena_uploader.py [--harness claude|gemini|codex|agent|opencode|all]
                                    [--since YYYY-MM-DD]
                                    [--dry-run]
                                    [--api-key KEY]
                                    [--api-url URL]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sqlite3
import sys
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------

__version__ = "0.1.0"

# ---------------------------------------------------------------------------
# Enums — closed sets, never free text
# ---------------------------------------------------------------------------


class Harness(str, Enum):
    """Supported CLI harnesses. Values match CLI flag strings."""

    CLAUDE = "claude"
    GEMINI = "gemini"
    CODEX = "codex"
    AGENT = "agent"       # Cursor Agent
    OPENCODE = "opencode"


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


# ---------------------------------------------------------------------------
# Data Model — dataclasses mirror the upload schema exactly
# ---------------------------------------------------------------------------
#
# Nullability contract:
#   Every field is required (NOT NULL) unless annotated Optional with a
#   justification comment. The API server should enforce the same contract.
#
# Privacy contract:
#   No field in any dataclass below may contain message content, file
#   contents, code snippets, API keys, credentials, tool call arguments,
#   tool call results, or full filesystem paths.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TokenUsage:
    """Aggregated token counts for one session.

    All counts are integers >= 0. A harness that does not report a
    particular counter should leave it at 0 (not null).
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0    # tokens served from KV cache
    cache_write_tokens: int = 0   # tokens written to KV cache
    total_tokens: int = 0         # input + output (may differ from sum if harness reports its own total)

    def __post_init__(self) -> None:
        for f in (
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
            self.total_tokens,
        ):
            if not isinstance(f, int) or f < 0:
                raise ValueError(f"Token counts must be non-negative integers, got {f!r}")


@dataclass(frozen=True)
class ToolCallSummary:
    """Aggregated count of a single tool type within a session.

    Only the tool *name* and its invocation count are stored.
    Arguments and results are NEVER captured.
    """

    tool_name: str          # e.g. "Read", "Edit", "Bash", "WebSearch"
    invocation_count: int   # >= 1

    def __post_init__(self) -> None:
        if not self.tool_name or not self.tool_name.strip():
            raise ValueError("tool_name must be a non-empty string")
        if not isinstance(self.invocation_count, int) or self.invocation_count < 1:
            raise ValueError(f"invocation_count must be >= 1, got {self.invocation_count!r}")


@dataclass(frozen=True)
class HarnessMeta:
    """Metadata about the harness itself (not per-session).

    Captured once per harness per upload batch. Helps track which
    versions and configurations are in use across the community.

    All fields are required (NOT NULL) unless explicitly marked Optional
    with a justification. Strict validation in __post_init__.
    """

    name: Harness                       # which CLI tool — required
    cli_version: str                    # e.g. "2.1.17", "0.117.0" — required, fail if can't detect
    os_name: str                        # e.g. "darwin", "linux", "windows" — required
    os_arch: str                        # e.g. "arm64", "x86_64" — required
    provider: str                       # e.g. "anthropic", "openai", "google", "cursor" — required
    shell: str                          # e.g. "zsh", "bash", "fish" — required
    source: str                         # e.g. "cli", "vscode", "ide" — required, default "cli"
    default_model: Optional[str] = None # nullable: not all harnesses have a configured default
    plugin_version: Optional[str] = None  # nullable: only harnesses with plugin systems (e.g. opencode)
    config_hash: Optional[str] = None   # nullable: sha256 of non-sensitive config keys

    def __post_init__(self) -> None:
        if not isinstance(self.name, Harness):
            raise ValueError(f"name must be a Harness enum, got {self.name!r}")
        if not self.cli_version or not self.cli_version.strip():
            raise ValueError(f"cli_version is required for {self.name.value}, got {self.cli_version!r}")
        if not self.os_name or not self.os_name.strip():
            raise ValueError("os_name is required")
        if not self.os_arch or not self.os_arch.strip():
            raise ValueError("os_arch is required")
        if not self.provider or not self.provider.strip():
            raise ValueError(f"provider is required for {self.name.value}")
        if not self.shell or not self.shell.strip():
            raise ValueError("shell is required")
        if not self.source or not self.source.strip():
            raise ValueError("source is required")


@dataclass(frozen=True)
class SessionMeta:
    """Unified metadata for one chat session from any harness.

    This is the central data object that gets uploaded. Every field is
    chosen to be non-sensitive metadata only.
    """

    # --- Identity -----------------------------------------------------------
    id: str                         # deterministic: sha256(harness + source_session_id)
    source_session_id: str          # original session ID from the harness — required
    harness: Harness                # which CLI tool produced this session — required
    harness_version: Optional[str]  # CLI version — resolved from history or installed binary

    # --- Project context (basenames only, never full paths) -----------------
    project_name: Optional[str]     # nullable: basename of project dir; may be absent
    git_repo_name: Optional[str]    # nullable: not all sessions are in a git repo
    git_branch: Optional[str]       # nullable: detached HEAD or no repo

    # --- Model --------------------------------------------------------------
    model: str                      # e.g. "claude-opus-4-20250514", "gemini-2.5-pro" — required
    provider: str                   # e.g. "anthropic", "openai", "google" — required

    # --- Counts (required, no defaults) --------------------------------------
    message_count_user: int         # number of user turns
    message_count_assistant: int    # number of assistant turns
    message_count_total: int        # all roles combined
    tool_call_count: int            # total tool invocations across session

    # --- Token usage (required) ---------------------------------------------
    tokens: TokenUsage

    # --- Counts with defaults ------------------------------------------------
    subagent_calls: int = 0         # Agent tool invocations (subagents spawned)
    background_agents: int = 0      # agents launched in background mode
    mcp_calls: int = 0              # MCP server tool invocations
    plan_mode_entries: int = 0      # times plan/think mode was entered
    plan_mode_exits: int = 0        # times plan/think mode was exited

    # --- Tool breakdown (may be empty) --------------------------------------
    tool_calls: tuple[ToolCallSummary, ...] = field(default_factory=tuple)

    # --- Skills used (name → {count, source}) -----------------------------
    skills_used: dict = field(default_factory=dict)

    # --- Daily breakdown (date → metrics) ---------------------------------
    daily: list = field(default_factory=list)

    # --- Cost ---------------------------------------------------------------
    cost_usd: Optional[float] = None

    # --- Derived metrics ----------------------------------------------------
    intervention_rate: Optional[float] = None  # user prompts / tool calls

    # --- Timing (UTC ISO 8601) ----------------------------------------------
    started_at: str = ""
    ended_at: Optional[str] = None
    duration_seconds: Optional[int] = None

    def __post_init__(self) -> None:
        if not self.id or not self.id.strip():
            raise ValueError("id is required")
        if not self.source_session_id or not self.source_session_id.strip():
            raise ValueError("source_session_id is required")
        if not isinstance(self.harness, Harness):
            raise ValueError(f"harness must be a Harness enum, got {self.harness!r}")
        # harness_version validated at upload time (batch builder patches it from HarnessMeta)
        if not self.model or not self.model.strip():
            raise ValueError("model is required")
        if not self.provider or not self.provider.strip():
            raise ValueError("provider is required")
        if not self.started_at or not self.started_at.strip():
            raise ValueError("started_at is required")
        for count_field in ("message_count_user", "message_count_assistant",
                            "message_count_total", "tool_call_count"):
            val = getattr(self, count_field)
            if not isinstance(val, int) or val < 0:
                raise ValueError(f"{count_field} must be non-negative int, got {val!r}")
        if self.cost_usd is not None and self.cost_usd < 0:
            raise ValueError(f"cost_usd must be non-negative, got {self.cost_usd!r}")
        if self.duration_seconds is not None and self.duration_seconds < 0:
            raise ValueError(f"duration_seconds must be non-negative, got {self.duration_seconds!r}")


@dataclass(frozen=True)
class UploadBatch:
    """A single invocation of the uploader. Groups sessions for atomic upload."""

    id: str                                  # UUIDv4 generated at invocation time
    tool_version: str                        # __version__ of this script
    harnesses_scanned: tuple[Harness, ...]   # which harnesses were included
    harness_meta: tuple[HarnessMeta, ...]    # per-harness metadata (versions, config)
    sessions: tuple[SessionMeta, ...]        # the extracted metadata
    machine_id: str                          # sha256 of hostname — not the hostname itself
    created_at: str                          # ISO 8601 UTC

    session_count: int = 0                   # len(sessions), denormalized for quick access
    total_tokens: int = 0                    # sum of all session token totals

    def __post_init__(self) -> None:
        if not self.sessions:
            raise ValueError("UploadBatch must contain at least one session")
        # Enforce denormalized fields via object.__setattr__ on frozen dataclass
        object.__setattr__(self, "session_count", len(self.sessions))
        object.__setattr__(
            self,
            "total_tokens",
            sum(s.tokens.total_tokens for s in self.sessions),
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Harness Abstraction Layer
# ---------------------------------------------------------------------------
# Each harness (Claude, Gemini, Codex, etc.) stores session data differently
# but we extract the same set of concepts from all of them. The ABC below
# defines the concept detection interface; each harness subclass provides
# its own implementation.
# ---------------------------------------------------------------------------


class HarnessParser(ABC):
    """Base class for harness session parsers.

    Subclasses MUST set `harness_type` and implement `parse()`.
    Concept detectors have default no-op implementations — override only
    those that apply to your harness.
    """

    harness_type: Harness

    @abstractmethod
    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        """Discover and parse all sessions for this harness."""
        ...

    # --- Concept detectors (override per harness) ---------------------------

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        """Return True if this tool call spawns a subagent."""
        return False

    def detect_background_agent(self, tool_name: str, tool_input: dict) -> bool:
        """Return True if this tool call spawns a background agent."""
        return False

    def detect_mcp_call(self, tool_name: str) -> bool:
        """Return True if this tool call targets an MCP server."""
        return tool_name.startswith("mcp__")

    def detect_skill(self, tool_name: str, tool_input: dict) -> Optional[str]:
        """Return skill name if this is a skill invocation, else None."""
        return None

    def detect_plan_mode_enter(self, tool_name: str) -> bool:
        """Return True if this tool call enters plan/think mode."""
        return False

    def detect_plan_mode_exit(self, tool_name: str) -> bool:
        """Return True if this tool call exits plan/think mode."""
        return False

    # --- Unified dispatch ---------------------------------------------------

    def classify_tool_call(self, tool_name: str, tool_input: dict) -> dict:
        """Classify a single tool call against all concept detectors."""
        return {
            "is_subagent": self.detect_subagent(tool_name, tool_input),
            "is_background_agent": self.detect_background_agent(tool_name, tool_input),
            "is_mcp": self.detect_mcp_call(tool_name),
            "skill_name": self.detect_skill(tool_name, tool_input),
            "is_plan_enter": self.detect_plan_mode_enter(tool_name),
            "is_plan_exit": self.detect_plan_mode_exit(tool_name),
        }

    # --- Shared helpers -----------------------------------------------------

    @staticmethod
    def compute_intervention_rate(
        user_count: int, tool_call_count: int
    ) -> Optional[float]:
        if tool_call_count > 0:
            return round(user_count / tool_call_count, 2)
        return None


# ---------------------------------------------------------------------------
# Parsers — one per harness
# ---------------------------------------------------------------------------
# Each parser returns a list of SessionMeta. Parsers read the minimum data
# needed to populate metadata fields and skip over all message content.
# ---------------------------------------------------------------------------


class ClaudeParser(HarnessParser):
    """Claude Code session parser."""

    harness_type = Harness.CLAUDE

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        return tool_name == "Agent"

    def detect_background_agent(self, tool_name: str, tool_input: dict) -> bool:
        return (tool_name == "Agent"
                and isinstance(tool_input, dict)
                and bool(tool_input.get("run_in_background")))

    def detect_mcp_call(self, tool_name: str) -> bool:
        return tool_name.startswith("mcp__")

    def detect_skill(self, tool_name: str, tool_input: dict) -> Optional[str]:
        if tool_name == "Skill" and isinstance(tool_input, dict):
            return tool_input.get("skill", "unknown")
        return None

    def detect_plan_mode_enter(self, tool_name: str) -> bool:
        return tool_name == "EnterPlanMode"

    def detect_plan_mode_exit(self, tool_name: str) -> bool:
        return tool_name == "ExitPlanMode"

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_claude(since, parser=self)


def _parse_claude(
    since: Optional[datetime] = None,
    parser: Optional[HarnessParser] = None,
) -> list[SessionMeta]:
    """Parse Claude Code session metadata from ALL storage locations.

    Sources (checked in order, merged):
      1. ~/.claude/projects/{encoded_path}/*.jsonl  — RICH DATA: messages, tokens,
         tool calls, version, model per message. This is the primary source.
      2. ~/Library/Application Support/Claude/claude-code-sessions/ — lightweight
         session metadata (fallback for sessions not in projects dir).

    JSONL line types we extract metadata from (never reading message content):
      - "user": version, timestamp, cwd, sessionId, entrypoint
      - "assistant": message.model, message.usage.{input_tokens, output_tokens, ...},
                     message.content[].type == "tool_use" (count only, not args/results)
      - "system": subtype (for counting)

    Privacy: We count messages and tool calls but NEVER read content/text fields.
    """
    results: list[SessionMeta] = []
    seen_session_ids: set[str] = set()
    # Prompt dedup keys: text[:100] + bucketed timestamp, shared between JSONL and history.jsonl
    all_prompt_keys: set[str] = set()

    # --- Source 1: JSONL sessions in ~/.claude/projects/ (rich data) ---
    projects_dir = Path.home() / ".claude" / "projects"
    if projects_dir.is_dir():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            # Project name: decode from dir name like "-Users-tomkit-Projects-angry-bird-clone"
            # The encoding replaces "/" with "-", but project names can contain hyphens.
            # Strategy: use the cwd from the first JSONL entry (most reliable),
            # or fall back to stripping the known home-dir prefix pattern.
            project_name = _decode_claude_project_dir(project_dir.name)

            for jsonl_file in project_dir.glob("*.jsonl"):
                try:
                    session, session_prompt_keys = _parse_claude_jsonl(jsonl_file, project_name, since, parser=parser)
                    all_prompt_keys.update(session_prompt_keys)
                    if session and session.source_session_id not in seen_session_ids:
                        results.append(session)
                        seen_session_ids.add(session.source_session_id)
                except Exception:
                    continue

            # --- Source 1b: sessions-index.json for pruned sessions ---
            # Claude Code prunes old JSONL files but keeps a lightweight index
            # with session metadata (messageCount, created, modified, etc.)
            index_file = project_dir / "sessions-index.json"
            if index_file.is_file():
                try:
                    with open(index_file, "r", encoding="utf-8") as f:
                        index_data = json.load(f)
                    for entry in index_data.get("entries", []):
                        source_id = entry.get("sessionId", "")
                        if not source_id or source_id in seen_session_ids:
                            continue

                        created = entry.get("created", "")
                        modified = entry.get("modified", "")
                        if since and created:
                            try:
                                session_start = datetime.fromisoformat(
                                    created.replace("Z", "+00:00")
                                )
                                if session_start < since.replace(tzinfo=timezone.utc):
                                    continue
                            except ValueError:
                                pass

                        # Use the decoded dir name as project (most reliable).
                        # projectPath may point to a subdirectory (e.g., .../ticketfight-ai/public)
                        # which would give a misleading basename.
                        idx_project = project_name

                        msg_count = entry.get("messageCount", 0)
                        duration = None
                        if created and modified:
                            try:
                                t1 = datetime.fromisoformat(created.replace("Z", "+00:00"))
                                t2 = datetime.fromisoformat(modified.replace("Z", "+00:00"))
                                duration = max(0, int((t2 - t1).total_seconds()))
                            except ValueError:
                                pass

                        results.append(SessionMeta(
                            id=_make_session_id(Harness.CLAUDE, source_id),
                            source_session_id=source_id,
                            harness=Harness.CLAUDE,
                            harness_version=None,
                            project_name=idx_project,
                            git_repo_name=idx_project,
                            git_branch=entry.get("gitBranch"),
                            model="unknown",
                            provider="anthropic",
                            # messageCount includes user+assistant — not a reliable
                            # user prompt count. Set to 0; history.jsonl provides
                            # accurate per-prompt deduped counts via Source 1c.
                            message_count_user=0,
                            message_count_assistant=0,
                            message_count_total=msg_count,
                            tool_call_count=0,
                            tokens=TokenUsage(),
                            cost_usd=None,
                            started_at=created,
                            ended_at=modified,
                            duration_seconds=duration,
                        ))
                        seen_session_ids.add(source_id)
                except Exception:
                    continue

    # --- Source 1c: history.jsonl — global prompt log (fills gaps for pruned sessions) ---
    # history.jsonl records every user prompt with project path + timestamp.
    # Most complete record of prompt counts, even when JSONL files are pruned.
    # We dedup against JSONL sessions using text[:100] + 5s-bucketed timestamp
    # as a shared key — only prompts NOT already seen in JSONL are counted.
    history_file = Path.home() / ".claude" / "history.jsonl"
    if history_file.is_file():
        # Group unseen history prompts by project
        history_new: dict[str, list[int]] = {}  # project → [ts_ms, ...]
        try:
            with open(history_file, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    project_path = entry.get("project", "")
                    ts_ms = entry.get("timestamp", 0)
                    display = entry.get("display", "")
                    if not project_path or not ts_ms or not display:
                        continue
                    if since:
                        try:
                            entry_dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
                            if entry_dt < since.replace(tzinfo=timezone.utc):
                                continue
                        except (OSError, OverflowError):
                            continue
                    # Dedup: skip if this prompt was already seen in a JSONL session
                    prompt_key = _make_prompt_key(display[:100], ts_ms)
                    if prompt_key in all_prompt_keys:
                        continue
                    all_prompt_keys.add(prompt_key)
                    proj_name = _basename_only(project_path)
                    if not proj_name:
                        continue
                    if proj_name not in history_new:
                        history_new[proj_name] = []
                    history_new[proj_name].append(ts_ms)
        except OSError:
            history_new = {}

        # Create a supplementary session per project for the unseen prompts
        for proj_name, timestamps in history_new.items():
            if not timestamps:
                continue
            timestamps.sort()
            first_day = datetime.fromtimestamp(timestamps[0] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            last_day = datetime.fromtimestamp(timestamps[-1] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            source_id = f"history-supplement-{proj_name}"
            if source_id in seen_session_ids:
                continue
            results.append(SessionMeta(
                id=_make_session_id(Harness.CLAUDE, source_id),
                source_session_id=source_id,
                harness=Harness.CLAUDE,
                harness_version=None,
                project_name=proj_name,
                git_repo_name=proj_name,
                git_branch=None,
                model="unknown",
                provider="anthropic",
                message_count_user=len(timestamps),
                message_count_assistant=0,
                message_count_total=len(timestamps),
                tool_call_count=0,
                tokens=TokenUsage(),
                cost_usd=None,
                started_at=f"{first_day}T00:00:00Z",
                ended_at=f"{last_day}T23:59:59Z",
                duration_seconds=None,
            ))
            seen_session_ids.add(source_id)

    # --- Source 2: Session metadata in Application Support (fallback) ---
    for sessions_dir in [
        Path.home() / "Library" / "Application Support" / "Claude" / "claude-code-sessions",
        Path.home() / ".config" / "Claude" / "claude-code-sessions",
    ]:
        if not sessions_dir.is_dir():
            continue
        for json_file in sessions_dir.rglob("*.json"):
            try:
                with open(json_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    continue
                source_id = data.get("sessionId") or data.get("cliSessionId")
                if not source_id or source_id in seen_session_ids:
                    continue
                if data.get("isArchived", False):
                    continue

                created_ms = data.get("createdAt")
                if since and created_ms:
                    session_start = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc)
                    if session_start < since.replace(tzinfo=timezone.utc):
                        continue

                started_at = ""
                ended_at = None
                duration = None
                if created_ms:
                    started_at = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc).isoformat()
                last_ms = data.get("lastActivityAt")
                if last_ms:
                    ended_at = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc).isoformat()
                if created_ms and last_ms:
                    duration = max(0, int((last_ms - created_ms) / 1000))

                results.append(SessionMeta(
                    id=_make_session_id(Harness.CLAUDE, source_id),
                    source_session_id=source_id,
                    harness=Harness.CLAUDE,
                    harness_version=None,
                    project_name=_basename_only(data.get("cwd") or data.get("originCwd")),
                    git_repo_name=None,
                    git_branch=None,
                    model=data.get("model", "unknown"),
                    provider="anthropic",
                    message_count_user=0,
                    message_count_assistant=0,
                    message_count_total=0,
                    tool_call_count=0,
                    tokens=TokenUsage(),
                    cost_usd=None,
                    started_at=started_at,
                    ended_at=ended_at,
                    duration_seconds=duration,
                ))
                seen_session_ids.add(source_id)
            except Exception:
                continue

    return results


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


def _parse_claude_jsonl(
    jsonl_path: Path, project_name: str, since: Optional[datetime],
    parser: Optional[HarnessParser] = None,
) -> tuple[Optional[SessionMeta], set[str]]:
    """Parse a single Claude Code JSONL session file for metadata.

    Returns (SessionMeta, prompt_keys) where prompt_keys is a set of
    dedup keys for user prompts found in this file. These keys are used
    to reconcile with history.jsonl and avoid double-counting.

    Extracts: version, model, token counts, message counts, tool call counts,
    timestamps. NEVER reads message content or tool call arguments.
    """
    from collections import Counter

    session_id = jsonl_path.stem  # filename without .jsonl
    prompt_keys: set[str] = set()  # dedup keys for user prompts
    versions: set[str] = set()
    models: Counter = Counter()
    user_count = 0
    assistant_count = 0
    total_count = 0
    tool_call_count = 0
    subagent_calls = 0
    background_agents = 0
    mcp_calls = 0
    plan_mode_entries = 0
    plan_mode_exits = 0
    input_tokens = 0
    output_tokens = 0
    cache_read = 0
    cache_write = 0
    tool_names: Counter = Counter()
    skill_invocations: Counter = Counter()  # skill name → count
    first_ts: Optional[str] = None
    last_ts: Optional[str] = None
    cwd: Optional[str] = None

    # Daily breakdown: date → {tokens_in, tokens_out, prompts, tool_calls, ...}
    daily_data: dict[str, dict] = {}

    def _get_date(ts: Optional[str]) -> Optional[str]:
        if ts and len(ts) >= 10:
            return ts[:10]
        return None

    def _add_daily(date: str, **kwargs: int) -> None:
        if date not in daily_data:
            daily_data[date] = {
                "date": date, "tokens_in": 0, "tokens_out": 0, "tokens_total": 0,
                "prompts": 0, "sessions": 0, "subagent_calls": 0,
                "background_agents": 0, "tool_calls": 0, "mcp_calls": 0,
            }
        for k, v in kwargs.items():
            daily_data[date][k] = daily_data[date].get(k, 0) + v

    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            entry_type = entry.get("type", "")
            timestamp = entry.get("timestamp")
            date = _get_date(timestamp)
            if timestamp:
                if not first_ts or timestamp < first_ts:
                    first_ts = timestamp
                if not last_ts or timestamp > last_ts:
                    last_ts = timestamp

            if entry_type == "user":
                user_count += 1
                total_count += 1
                v = entry.get("version")
                if v:
                    versions.add(v)
                if not cwd:
                    cwd = entry.get("cwd")
                sid = entry.get("sessionId")
                if sid:
                    session_id = sid
                if date:
                    _add_daily(date, prompts=1)
                # Build prompt dedup key from display text + bucketed timestamp
                display = _extract_user_display_text(entry)
                if display and timestamp:
                    try:
                        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                        ts_ms = int(dt.timestamp() * 1000)
                        prompt_keys.add(_make_prompt_key(display, ts_ms))
                    except (ValueError, AttributeError):
                        pass

            elif entry_type == "assistant":
                assistant_count += 1
                total_count += 1
                msg = entry.get("message", {})
                model = msg.get("model")
                if model:
                    models[model] += 1
                usage = msg.get("usage", {})
                msg_in = usage.get("input_tokens", 0)
                msg_out = usage.get("output_tokens", 0)
                input_tokens += msg_in
                output_tokens += msg_out
                cache_read += usage.get("cache_read_input_tokens", 0)
                cache_write += usage.get("cache_creation_input_tokens", 0)

                if date:
                    _add_daily(date, tokens_in=msg_in, tokens_out=msg_out,
                               tokens_total=msg_in + msg_out)

                # Count tool_use blocks in content (never read arguments/results)
                content = msg.get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") != "tool_use":
                            continue
                        tool_call_count += 1
                        tool_name = block.get("name", "unknown")
                        tool_names[tool_name] += 1
                        if date:
                            _add_daily(date, tool_calls=1)

                        tool_input = block.get("input", {})
                        if not isinstance(tool_input, dict):
                            tool_input = {}

                        if parser:
                            c = parser.classify_tool_call(tool_name, tool_input)
                            if c["is_subagent"]:
                                subagent_calls += 1
                                if date:
                                    _add_daily(date, subagent_calls=1)
                                if c["is_background_agent"]:
                                    background_agents += 1
                                    if date:
                                        _add_daily(date, background_agents=1)
                            if c["skill_name"]:
                                skill_invocations[c["skill_name"]] += 1
                            if c["is_mcp"]:
                                mcp_calls += 1
                                if date:
                                    _add_daily(date, mcp_calls=1)
                            if c["is_plan_enter"]:
                                plan_mode_entries += 1
                            if c["is_plan_exit"]:
                                plan_mode_exits += 1
                        else:
                            # Fallback: inline detection (no parser instance)
                            if tool_name == "Agent":
                                subagent_calls += 1
                                if date:
                                    _add_daily(date, subagent_calls=1)
                                if tool_input.get("run_in_background"):
                                    background_agents += 1
                                    if date:
                                        _add_daily(date, background_agents=1)
                            elif tool_name == "Skill":
                                skill_invocations[tool_input.get("skill", "unknown")] += 1
                            elif tool_name.startswith("mcp__"):
                                mcp_calls += 1
                                if date:
                                    _add_daily(date, mcp_calls=1)

            elif entry_type == "system":
                total_count += 1

    # --- Also parse subagent JSONL files (same directory/{session_id}/subagents/) ---
    # Count subagents from BOTH tool_use blocks AND the directory listing
    # (use whichever is higher to avoid undercounting)
    subagents_dir = jsonl_path.parent / session_id / "subagents"
    if not subagents_dir.is_dir():
        subagents_dir = jsonl_path.parent / jsonl_path.stem / "subagents"
    subagent_files = list(subagents_dir.glob("*.jsonl")) if subagents_dir.is_dir() else []
    # Directory count is the ground truth — each file is a spawned subagent
    subagent_calls = max(subagent_calls, len(subagent_files))

    if subagents_dir.is_dir():
        for sub_jsonl in subagent_files:
            try:
                with open(sub_jsonl, "r", encoding="utf-8") as sf:
                    for line in sf:
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        entry_type = entry.get("type", "")
                        timestamp = entry.get("timestamp")
                        date = _get_date(timestamp)
                        if timestamp:
                            if not last_ts or timestamp > last_ts:
                                last_ts = timestamp

                        if entry_type == "assistant":
                            assistant_count += 1
                            total_count += 1
                            msg = entry.get("message", {})
                            model = msg.get("model")
                            if model:
                                models[model] += 1
                            usage = msg.get("usage", {})
                            msg_in = usage.get("input_tokens", 0)
                            msg_out = usage.get("output_tokens", 0)
                            input_tokens += msg_in
                            output_tokens += msg_out
                            cache_read += usage.get("cache_read_input_tokens", 0)
                            cache_write += usage.get("cache_creation_input_tokens", 0)
                            if date:
                                _add_daily(date, tokens_in=msg_in, tokens_out=msg_out,
                                           tokens_total=msg_in + msg_out)
                            content = msg.get("content", [])
                            if isinstance(content, list):
                                for block in content:
                                    if not isinstance(block, dict) or block.get("type") != "tool_use":
                                        continue
                                    tool_call_count += 1
                                    tool_name = block.get("name", "unknown")
                                    tool_names[tool_name] += 1
                                    if date:
                                        _add_daily(date, tool_calls=1)
                                    if parser:
                                        ti = block.get("input", {})
                                        if not isinstance(ti, dict):
                                            ti = {}
                                        c = parser.classify_tool_call(tool_name, ti)
                                        if c["is_mcp"]:
                                            mcp_calls += 1
                                            if date:
                                                _add_daily(date, mcp_calls=1)
                                    elif tool_name.startswith("mcp__"):
                                        mcp_calls += 1
                                        if date:
                                            _add_daily(date, mcp_calls=1)
                        elif entry_type == "user":
                            # Subagent "user" entries are system-generated
                            # (parent agent sending tasks), not human prompts.
                            # Count for total messages but NOT as user prompts.
                            total_count += 1
            except Exception:
                continue

    if user_count == 0 and assistant_count == 0:
        return None, prompt_keys

    # Apply --since filter
    if since and first_ts:
        try:
            session_start = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
            if session_start < since.replace(tzinfo=timezone.utc):
                return None, prompt_keys
        except ValueError:
            pass

    # Resolve project name from cwd if available
    if cwd:
        project_name = _basename_only(cwd)

    # Most common model
    top_model = models.most_common(1)[0][0] if models else "unknown"

    # Version: use the set of versions seen (may span upgrades within session)
    sorted_versions = sorted(versions)
    harness_version = None
    if sorted_versions:
        harness_version = sorted_versions[0] if len(sorted_versions) == 1 else f"{sorted_versions[0]}..{sorted_versions[-1]}"

    # Timestamps
    started_at = first_ts or ""
    ended_at = last_ts
    duration = None
    if first_ts and last_ts:
        try:
            t1 = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
            t2 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            duration = max(0, int((t2 - t1).total_seconds()))
        except ValueError:
            pass

    total_tokens = input_tokens + output_tokens

    tool_summaries = tuple(
        ToolCallSummary(tool_name=name, invocation_count=count)
        for name, count in tool_names.most_common()
    )

    # Build skills_used dict (name → {count, source})
    skills = {}
    for skill_name, count in skill_invocations.most_common():
        # Determine source: project-custom if in .claude/skills/, user-custom otherwise
        source = "user-custom"
        project_skills_dir = Path.home() / ".claude" / "skills" / skill_name
        if not project_skills_dir.is_dir():
            # Check project-level skills
            project_custom = jsonl_path.parent / ".." / ".." / ".claude" / "skills" / skill_name
            if project_custom.is_dir():
                source = "project-custom"
        skills[skill_name] = {"count": count, "source": source}

    # Compute intervention_rate: user prompts / tool calls (lower = more autonomous)
    intervention = None
    if tool_call_count > 0:
        intervention = round(user_count / tool_call_count, 2)

    # Mark first date as having 1 session
    if first_ts:
        first_date = _get_date(first_ts)
        if first_date and first_date in daily_data:
            daily_data[first_date]["sessions"] = 1

    daily_list = sorted(daily_data.values(), key=lambda d: d["date"])

    return SessionMeta(
        id=_make_session_id(Harness.CLAUDE, session_id),
        source_session_id=session_id,
        harness=Harness.CLAUDE,
        harness_version=harness_version,
        project_name=project_name,
        git_repo_name=project_name,
        git_branch=None,
        model=top_model,
        provider="anthropic",
        message_count_user=user_count,
        message_count_assistant=assistant_count,
        message_count_total=total_count,
        tool_call_count=tool_call_count,
        subagent_calls=subagent_calls,
        background_agents=background_agents,
        mcp_calls=mcp_calls,
        plan_mode_entries=plan_mode_entries,
        plan_mode_exits=plan_mode_exits,
        tokens=TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            total_tokens=total_tokens,
        ),
        tool_calls=tool_summaries,
        skills_used=skills,
        daily=daily_list,
        cost_usd=None,
        intervention_rate=intervention,
        started_at=started_at,
        ended_at=ended_at,
        duration_seconds=duration,
    ), prompt_keys


class GeminiParser(HarnessParser):
    """Gemini CLI session parser."""

    harness_type = Harness.GEMINI

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_gemini(since)


def _parse_gemini(since: Optional[datetime] = None) -> list[SessionMeta]:
    """Parse Gemini CLI JSON session files.

    Path: ~/.gemini/tmp/{project_hash}/chats/session-{date}-{id}.json
    Top-level: {sessionId, projectHash, startTime, lastUpdated, messages[...]}
    Messages: {id, timestamp, type, content, thoughts, tokens, model}
      - type "user" = user turn, type "gemini" = assistant turn
      - tokens: {input, output, cached, thoughts, tool, total}
      - model is on individual messages, not top-level

    We read ONLY metadata (type, model, tokens, timestamps).
    Content and thoughts fields are NEVER captured.
    """
    gemini_dir = Path.home() / ".gemini" / "tmp"
    if not gemini_dir.is_dir():
        return []

    results: list[SessionMeta] = []

    for project_dir in gemini_dir.iterdir():
        if not project_dir.is_dir():
            continue
        chats_dir = project_dir / "chats"
        if not chats_dir.is_dir():
            continue

        for session_file in chats_dir.glob("session-*.json"):
            try:
                with open(session_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue

            source_id = data.get("sessionId", session_file.stem)
            messages = data.get("messages", [])
            if not messages:
                continue

            # Timestamps from top-level envelope (ISO 8601)
            started_at = data.get("startTime", "")
            ended_at = data.get("lastUpdated") or None

            # Apply --since filter
            if since and started_at:
                try:
                    session_start = datetime.fromisoformat(
                        started_at.replace("Z", "+00:00")
                    )
                    if session_start < since.replace(tzinfo=timezone.utc):
                        continue
                except ValueError:
                    pass

            # Project hash (already non-reversible, privacy-safe)
            project_hash = data.get("projectHash")
            # Also check the directory name as fallback
            project_name = project_hash or _basename_only(str(project_dir))

            model = "unknown"
            user_count = 0
            assistant_count = 0
            input_tokens = 0
            output_tokens = 0
            cache_read = 0

            for msg in messages:
                msg_type = msg.get("type", "")
                if msg_type == "user":
                    user_count += 1
                elif msg_type in ("gemini", "assistant", "model"):
                    assistant_count += 1
                    # Model is on assistant messages
                    m = msg.get("model")
                    if m:
                        model = m

                tokens = msg.get("tokens", {}) or {}
                input_tokens += _safe_int(tokens.get("input"))
                output_tokens += _safe_int(tokens.get("output"))
                cache_read += _safe_int(tokens.get("cached"))

            total_count = len(messages)

            # Duration from timestamps
            duration = None
            if started_at and ended_at:
                try:
                    s = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                    e = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
                    duration = max(0, int((e - s).total_seconds()))
                except ValueError:
                    pass

            results.append(SessionMeta(
                id=_make_session_id(Harness.GEMINI, source_id),
                source_session_id=source_id,
                harness=Harness.GEMINI,
                harness_version=None,
                project_name=project_name,
                git_repo_name=None,  # Gemini uses project hash, not repo name
                git_branch=None,
                model=model,
                provider="google",
                message_count_user=user_count,
                message_count_assistant=assistant_count,
                message_count_total=total_count,
                tool_call_count=0,
                tokens=TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read_tokens=cache_read,
                    total_tokens=input_tokens + output_tokens,
                ),
                cost_usd=None,
                started_at=started_at,
                ended_at=ended_at,
                duration_seconds=duration,
            ))

    return results


class CodexParser(HarnessParser):
    """Codex CLI session parser.

    Codex JSONL stores events as {type, payload, timestamp} envelopes.
    Tool calls appear as response_item with payload.type == "function_call"
    and payload.name == tool name (e.g. "shell", "read_file").
    """

    harness_type = Harness.CODEX

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_codex(since, parser=self)


def _parse_codex(since: Optional[datetime] = None, parser: Optional[HarnessParser] = None) -> list[SessionMeta]:
    """Parse Codex SQLite database + JSONL session files.

    SQLite: ~/.codex/state_5.sqlite table `threads`
    Sessions: ~/.codex/sessions/{y}/{m}/{d}/rollout-*.jsonl
    """
    db_path = Path.home() / ".codex" / "state_5.sqlite"
    if not db_path.is_file():
        return []

    results: list[SessionMeta] = []

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # created_at in Codex is Unix epoch seconds (integer)
        query = """
            SELECT id, cwd, model, title, tokens_used, source,
                   cli_version, git_sha, git_branch, created_at
            FROM threads
        """
        params: list = []
        if since:
            query += " WHERE created_at >= ?"
            params.append(int(since.replace(tzinfo=timezone.utc).timestamp()))

        cursor.execute(query, params)

        for row in cursor.fetchall():
            source_id = str(row["id"])
            model = row["model"] if row["model"] else "unknown"
            total_tokens = _safe_int(row["tokens_used"])
            project_name = _basename_only(row["cwd"])
            git_branch = row["git_branch"]
            harness_version = row["cli_version"]
            started_at = _parse_timestamp(row["created_at"])

            results.append(SessionMeta(
                id=_make_session_id(Harness.CODEX, source_id),
                source_session_id=source_id,
                harness=Harness.CODEX,
                harness_version=str(harness_version) if harness_version else None,
                project_name=project_name,
                git_repo_name=project_name,
                git_branch=git_branch,
                model=model,
                provider="openai",
                message_count_user=0,     # not in threads table; would need JSONL parse
                message_count_assistant=0,
                message_count_total=0,
                tool_call_count=0,
                tokens=TokenUsage(total_tokens=total_tokens),
                started_at=started_at,
            ))

        conn.close()
    except sqlite3.Error:
        pass

    # Enrich sessions from JSONL rollout files
    # Codex JSONL format: {type, payload, timestamp} envelopes
    #   type=session_meta — has payload.id matching SQLite thread ID
    #   type=response_item, payload.type=message, payload.role=user/assistant
    #   type=response_item, payload.type=function_call, payload.name=tool_name
    session_lookup = {s.source_session_id: i for i, s in enumerate(results)}
    sessions_dir = Path.home() / ".codex" / "sessions"
    if sessions_dir.is_dir():
        for jsonl_file in sessions_dir.rglob("rollout-*.jsonl"):
            try:
                user_count = 0
                assistant_count = 0
                total_count = 0
                tool_count = 0
                tool_names: dict[str, int] = {}
                subagent_calls = 0
                background_agents = 0
                mcp_calls = 0
                plan_mode_entries = 0
                plan_mode_exits = 0
                jsonl_session_id: Optional[str] = None
                jsonl_project: Optional[str] = None
                jsonl_version: Optional[str] = None
                jsonl_started: Optional[str] = None

                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        entry_type = entry.get("type", "")
                        payload = entry.get("payload", {})
                        if not isinstance(payload, dict):
                            continue

                        if entry_type == "session_meta":
                            jsonl_session_id = payload.get("id")
                            jsonl_project = _basename_only(payload.get("cwd"))
                            jsonl_version = payload.get("cli_version")
                            jsonl_started = _parse_timestamp(payload.get("timestamp"))
                        elif entry_type == "response_item":
                            ptype = payload.get("type", "")
                            if ptype == "message":
                                role = payload.get("role", "")
                                if role == "user":
                                    user_count += 1
                                elif role == "assistant":
                                    assistant_count += 1
                                total_count += 1
                            elif ptype == "function_call":
                                tool_name = payload.get("name", "unknown")
                                tool_count += 1
                                tool_names[tool_name] = tool_names.get(tool_name, 0) + 1
                                if parser:
                                    c = parser.classify_tool_call(tool_name, {})
                                    if c["is_subagent"]:
                                        subagent_calls += 1
                                        if c["is_background_agent"]:
                                            background_agents += 1
                                    if c["is_mcp"]:
                                        mcp_calls += 1
                                    if c["is_plan_enter"]:
                                        plan_mode_entries += 1
                                    if c["is_plan_exit"]:
                                        plan_mode_exits += 1
                        elif entry_type == "event_msg":
                            total_count += 1

                # Enrich matching SQLite session, or create standalone
                if jsonl_session_id and jsonl_session_id in session_lookup:
                    idx = session_lookup[jsonl_session_id]
                    old = results[idx]
                    d = {f.name: getattr(old, f.name) for f in old.__dataclass_fields__.values()}
                    d["message_count_user"] = user_count
                    d["message_count_assistant"] = assistant_count
                    d["message_count_total"] = total_count
                    d["tool_call_count"] = tool_count
                    d["subagent_calls"] = subagent_calls
                    d["background_agents"] = background_agents
                    d["mcp_calls"] = mcp_calls
                    d["plan_mode_entries"] = plan_mode_entries
                    d["plan_mode_exits"] = plan_mode_exits
                    d["tool_calls"] = tuple(
                        ToolCallSummary(n, c) for n, c in sorted(tool_names.items())
                    )
                    results[idx] = SessionMeta(**d)

            except (OSError, PermissionError):
                continue

    return results


class CursorAgentParser(HarnessParser):
    """Cursor Agent CLI session parser.

    Cursor Agent stores sessions in ~/.cursor/chats/{hash}/{uuid}/store.db.
    Meta table has hex-encoded JSON with agentId, name, mode, createdAt.
    Blobs table has message content with tool-call/tool-result types.
    """

    harness_type = Harness.AGENT

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_cursor_agent(since, parser=self)


def _parse_cursor_agent(since: Optional[datetime] = None, parser: Optional[HarnessParser] = None) -> list[SessionMeta]:
    """Parse Cursor Agent SQLite databases.

    Path: ~/.cursor/chats/{hash}/{uuid}/store.db
    Meta table has hex-encoded JSON with agentId, name, mode,
    lastUsedModel, createdAt.
    Blobs table has message bytes: {role, content: [{type, toolName, ...}]}
    """
    cursor_dir = Path.home() / ".cursor" / "chats"
    if not cursor_dir.is_dir():
        return []

    results: list[SessionMeta] = []

    for hash_dir in cursor_dir.iterdir():
        if not hash_dir.is_dir():
            continue
        for uuid_dir in hash_dir.iterdir():
            if not uuid_dir.is_dir():
                continue
            db_path = uuid_dir / "store.db"
            if not db_path.is_file():
                continue

            try:
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                conn.row_factory = sqlite3.Row
                db_cursor = conn.cursor()

                # The meta table stores hex-encoded JSON
                db_cursor.execute("SELECT * FROM meta LIMIT 1")
                row = db_cursor.fetchone()
                if not row:
                    conn.close()
                    continue

                # Try to decode the hex-encoded value
                # The meta table has columns (key, value) where value is hex-encoded JSON
                raw = None
                for col_name in dict(row).keys():
                    val = row[col_name]
                    if isinstance(val, str) and len(val) > 20:
                        try:
                            decoded = bytes.fromhex(val).decode("utf-8")
                            parsed = json.loads(decoded)
                            if isinstance(parsed, dict):
                                raw = parsed
                                break
                        except (ValueError, json.JSONDecodeError):
                            pass
                    elif isinstance(val, bytes) and len(val) > 20:
                        try:
                            parsed = json.loads(val.decode("utf-8"))
                            if isinstance(parsed, dict):
                                raw = parsed
                                break
                        except (ValueError, json.JSONDecodeError):
                            pass

                if not raw or not isinstance(raw, dict):
                    conn.close()
                    continue

                source_id = raw.get("agentId", uuid_dir.name)
                model = raw.get("lastUsedModel", "unknown")
                created_at = raw.get("createdAt", "")

                if since and created_at:
                    try:
                        ts = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
                        if ts < since.replace(tzinfo=timezone.utc):
                            conn.close()
                            continue
                    except ValueError:
                        pass

                # Parse blobs for message counts and tool calls
                user_count = 0
                assistant_count = 0
                total_count = 0
                tool_call_count = 0
                tool_names: dict[str, int] = {}
                subagent_calls = 0
                background_agents = 0
                mcp_calls = 0
                plan_mode_entries = 0
                plan_mode_exits = 0

                try:
                    db_cursor.execute("SELECT data FROM blobs")
                    for blob_row in db_cursor.fetchall():
                        blob_data = blob_row["data"]
                        try:
                            if isinstance(blob_data, bytes):
                                msg = json.loads(blob_data.decode("utf-8"))
                            elif isinstance(blob_data, str):
                                msg = json.loads(bytes.fromhex(blob_data).decode("utf-8"))
                            else:
                                continue
                        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                            continue
                        if not isinstance(msg, dict):
                            continue

                        role = msg.get("role", "")
                        if role == "user":
                            user_count += 1
                        elif role == "assistant":
                            assistant_count += 1
                        elif role == "tool":
                            pass  # tool results, not counted as messages
                        elif role == "system":
                            pass
                        total_count += 1

                        # Extract tool calls from content blocks
                        content = msg.get("content", [])
                        if isinstance(content, list):
                            for block in content:
                                if not isinstance(block, dict):
                                    continue
                                if block.get("type") == "tool-call":
                                    tool_name = block.get("toolName", "unknown")
                                    tool_call_count += 1
                                    tool_names[tool_name] = tool_names.get(tool_name, 0) + 1
                                    if parser:
                                        tool_input = block.get("args", {})
                                        if not isinstance(tool_input, dict):
                                            tool_input = {}
                                        c = parser.classify_tool_call(tool_name, tool_input)
                                        if c["is_subagent"]:
                                            subagent_calls += 1
                                            if c["is_background_agent"]:
                                                background_agents += 1
                                        if c["is_mcp"]:
                                            mcp_calls += 1
                                        if c["is_plan_enter"]:
                                            plan_mode_entries += 1
                                        if c["is_plan_exit"]:
                                            plan_mode_exits += 1
                except sqlite3.Error:
                    pass

                conn.close()

                started_at = ""
                if created_at:
                    try:
                        started_at = datetime.fromtimestamp(
                            int(created_at) / 1000, tz=timezone.utc
                        ).isoformat()
                    except (ValueError, OSError):
                        started_at = str(created_at)

                results.append(SessionMeta(
                    id=_make_session_id(Harness.AGENT, source_id),
                    source_session_id=source_id,
                    harness=Harness.AGENT,
                    harness_version=None,
                    project_name=None,
                    git_repo_name=None,
                    git_branch=None,
                    model=model,
                    provider="cursor",
                    message_count_user=user_count,
                    message_count_assistant=assistant_count,
                    message_count_total=total_count,
                    tool_call_count=tool_call_count,
                    subagent_calls=subagent_calls,
                    background_agents=background_agents,
                    mcp_calls=mcp_calls,
                    plan_mode_entries=plan_mode_entries,
                    plan_mode_exits=plan_mode_exits,
                    tokens=TokenUsage(),
                    tool_calls=tuple(
                        ToolCallSummary(n, c) for n, c in sorted(tool_names.items())
                    ),
                    started_at=started_at,
                ))

            except Exception as _exc:
                continue

    return results


class OpenCodeParser(HarnessParser):
    """OpenCode session parser.

    OpenCode stores sessions in SQLite (Drizzle ORM). Tool calls appear in the
    `part` table with type in (tool-call, tool_use, function_call) and toolName.
    """

    harness_type = Harness.OPENCODE

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_opencode(since, parser=self)


def _parse_opencode(since: Optional[datetime] = None, parser: Optional[HarnessParser] = None) -> list[SessionMeta]:
    """Parse OpenCode SQLite database.

    Path: ~/.local/share/opencode/opencode.db
    Tables:
      session: id, project_id, title, directory, time_created
      message: id, session_id, data JSON with role/model/tokens/cost
      part: id, message_id, data JSON with type/text
    """
    db_path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    if not db_path.is_file():
        return []

    results: list[SessionMeta] = []

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # time_created is Unix epoch milliseconds in OpenCode
        query = "SELECT id, project_id, title, directory, time_created FROM session"
        params: list = []
        if since:
            query += " WHERE time_created >= ?"
            params.append(int(since.replace(tzinfo=timezone.utc).timestamp() * 1000))

        cursor.execute(query, params)
        sessions = cursor.fetchall()

        for session_row in sessions:
            session_id = str(session_row["id"])
            project_name = _basename_only(session_row["directory"])
            started_at = _parse_timestamp(session_row["time_created"])

            # Aggregate message metadata — read only role, model ID, tokens, cost
            # NEVER read content, summary text, or diffs
            cursor.execute(
                "SELECT data FROM message WHERE session_id = ?",
                (session_row["id"],),
            )

            user_count = 0
            assistant_count = 0
            total_count = 0
            input_tokens = 0
            output_tokens = 0
            cost = 0.0
            model = "unknown"
            provider: Optional[str] = None
            ended_at = ""

            for msg_row in cursor.fetchall():
                total_count += 1
                try:
                    data = json.loads(msg_row["data"]) if isinstance(msg_row["data"], str) else {}
                except json.JSONDecodeError:
                    continue

                role = data.get("role", "")
                if role == "user":
                    user_count += 1
                elif role == "assistant":
                    assistant_count += 1

                # Model can be at data.modelID or data.model.modelID
                m = data.get("modelID") or data.get("model")
                if isinstance(m, dict):
                    m = m.get("modelID")
                if m:
                    model = m

                # Provider
                p = data.get("providerID")
                if p:
                    provider = p

                # Timestamps for end time
                time_info = data.get("time", {}) or {}
                completed = time_info.get("completed")
                if completed:
                    ended_at = _parse_timestamp(completed)

                tokens = data.get("tokens", {}) or {}
                input_tokens += _safe_int(tokens.get("input"))
                output_tokens += _safe_int(tokens.get("output"))

                c = data.get("cost")
                if c is not None:
                    try:
                        cost += float(c)
                    except (TypeError, ValueError):
                        pass

            # Count tool-type parts without reading content
            cursor.execute(
                """SELECT p.data FROM part p
                   JOIN message m ON p.message_id = m.id
                   WHERE m.session_id = ?""",
                (session_row["id"],),
            )
            tool_call_count = 0
            tool_counts: dict[str, int] = {}
            subagent_calls = 0
            background_agents = 0
            mcp_calls = 0
            plan_mode_entries = 0
            plan_mode_exits = 0
            for part_row in cursor.fetchall():
                try:
                    pdata = json.loads(part_row["data"]) if isinstance(part_row["data"], str) else {}
                except json.JSONDecodeError:
                    continue
                ptype = pdata.get("type", "")
                # OpenCode uses type="tool" with tool name in "tool" field
                # Other formats use tool-call/tool_use/function_call with toolName/name
                is_tool = False
                tool_name = "unknown_tool"
                if ptype in ("tool-call", "tool_use", "function_call"):
                    tool_name = pdata.get("toolName", pdata.get("name", "unknown_tool"))
                    is_tool = True
                elif ptype == "tool" and "tool" in pdata:
                    tool_name = pdata["tool"]
                    is_tool = True
                if is_tool:
                    tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
                    tool_call_count += 1
                    if parser:
                        tool_input = pdata.get("args", pdata.get("input", {}))
                        # OpenCode nests input in state.input
                        if not isinstance(tool_input, dict):
                            state = pdata.get("state", {})
                            tool_input = state.get("input", {}) if isinstance(state, dict) else {}
                        if not isinstance(tool_input, dict):
                            tool_input = {}
                        c = parser.classify_tool_call(tool_name, tool_input)
                        if c["is_subagent"]:
                            subagent_calls += 1
                            if c["is_background_agent"]:
                                background_agents += 1
                        if c["is_mcp"]:
                            mcp_calls += 1
                        if c["is_plan_enter"]:
                            plan_mode_entries += 1
                        if c["is_plan_exit"]:
                            plan_mode_exits += 1

            if total_count == 0:
                continue

            # Duration
            duration = None
            if started_at and ended_at:
                try:
                    s = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                    e = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
                    duration = max(0, int((e - s).total_seconds()))
                except ValueError:
                    pass

            results.append(SessionMeta(
                id=_make_session_id(Harness.OPENCODE, session_id),
                source_session_id=session_id,
                harness=Harness.OPENCODE,
                harness_version=None,
                project_name=project_name,
                git_repo_name=project_name,
                git_branch=None,
                model=model,
                provider=provider,
                message_count_user=user_count,
                message_count_assistant=assistant_count,
                message_count_total=total_count,
                tool_call_count=tool_call_count,
                tokens=TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=input_tokens + output_tokens,
                ),
                subagent_calls=subagent_calls,
                background_agents=background_agents,
                mcp_calls=mcp_calls,
                plan_mode_entries=plan_mode_entries,
                plan_mode_exits=plan_mode_exits,
                tool_calls=tuple(
                    ToolCallSummary(name, count)
                    for name, count in sorted(tool_counts.items())
                ),
                cost_usd=cost if cost > 0 else None,
                started_at=started_at,
                ended_at=ended_at if ended_at else None,
                duration_seconds=duration,
            ))

        conn.close()
    except sqlite3.Error:
        pass

    return results


# ---------------------------------------------------------------------------
# Parser registry
# ---------------------------------------------------------------------------

PARSERS: dict[Harness, HarnessParser] = {
    Harness.CLAUDE: ClaudeParser(),
    Harness.GEMINI: GeminiParser(),
    Harness.CODEX: CodexParser(),
    Harness.AGENT: CursorAgentParser(),
    Harness.OPENCODE: OpenCodeParser(),
}


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------


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


def upload_batch(batch: UploadBatch, api_url: str, api_key: str) -> bool:
    """Upload batch to harnessarena.com API.

    Uses urllib to avoid external dependencies.
    """
    import urllib.request
    import urllib.error

    payload = json.dumps(serialize_batch(batch), default=str).encode("utf-8")

    req = urllib.request.Request(
        f"{api_url}/api/v1/upload",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"harnessarena-uploader/{__version__}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            print(f"Upload successful: {body.get('message', 'OK')}", file=sys.stderr)
            return True
    except urllib.error.HTTPError as e:
        print(f"Upload failed (HTTP {e.code}): {e.read().decode()}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"Upload failed (network): {e.reason}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


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


if __name__ == "__main__":
    sys.exit(main())
