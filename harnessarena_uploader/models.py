from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


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
