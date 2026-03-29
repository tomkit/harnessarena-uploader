from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _expand_path(value: str) -> Path:
    return Path(value).expanduser()


@dataclass(frozen=True)
class CodexHistoryPaths:
    """Filesystem locations used to read Codex session history.

    Override precedence:
    1. Per-path env vars:
       - HARNESSARENA_CODEX_CONFIG_PATH
       - HARNESSARENA_CODEX_STATE_DB_PATH
       - HARNESSARENA_CODEX_SESSIONS_DIR
    2. HARNESSARENA_CODEX_HOME
    3. CODEX_HOME
    4. Default: ~/.codex
    """

    home: Path
    config_path: Path
    state_db_path: Path
    sessions_dir: Path


@dataclass(frozen=True)
class ClaudeHistoryPaths:
    """Filesystem locations used to read Claude Code session history.

    Override precedence:
    1. Per-path env vars:
       - HARNESSARENA_CLAUDE_PROJECTS_DIR
       - HARNESSARENA_CLAUDE_HISTORY_PATH
       - HARNESSARENA_CLAUDE_SESSION_ENV_DIR
       - HARNESSARENA_CLAUDE_APP_SESSIONS_DIR
    2. HARNESSARENA_CLAUDE_HOME
    3. Default: ~/.claude
    """

    home: Path
    projects_dir: Path
    history_path: Path
    session_env_dir: Path
    app_sessions_dir: Path


@dataclass(frozen=True)
class GeminiHistoryPaths:
    """Filesystem locations used to read Gemini CLI session history."""

    home: Path
    tmp_dir: Path
    skills_dir: Path
    agents_skills_dir: Path


@dataclass(frozen=True)
class CursorHistoryPaths:
    """Filesystem locations used to read Cursor Agent session history."""

    home: Path
    chats_dir: Path


@dataclass(frozen=True)
class OpenCodeHistoryPaths:
    """Filesystem locations used to read OpenCode session history."""

    home: Path
    db_path: Path
    config_dir: Path
    package_json_path: Path


def get_codex_history_paths() -> CodexHistoryPaths:
    codex_home = _expand_path(
        os.environ.get(
            "HARNESSARENA_CODEX_HOME",
            os.environ.get("CODEX_HOME", "~/.codex"),
        )
    )
    config_path = _expand_path(
        os.environ.get(
            "HARNESSARENA_CODEX_CONFIG_PATH",
            str(codex_home / "config.toml"),
        )
    )
    state_db_path = _expand_path(
        os.environ.get(
            "HARNESSARENA_CODEX_STATE_DB_PATH",
            str(codex_home / "state_5.sqlite"),
        )
    )
    sessions_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_CODEX_SESSIONS_DIR",
            str(codex_home / "sessions"),
        )
    )
    return CodexHistoryPaths(
        home=codex_home,
        config_path=config_path,
        state_db_path=state_db_path,
        sessions_dir=sessions_dir,
    )


def get_claude_history_paths() -> ClaudeHistoryPaths:
    claude_home = _expand_path(
        os.environ.get(
            "HARNESSARENA_CLAUDE_HOME",
            "~/.claude",
        )
    )
    projects_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_CLAUDE_PROJECTS_DIR",
            str(claude_home / "projects"),
        )
    )
    history_path = _expand_path(
        os.environ.get(
            "HARNESSARENA_CLAUDE_HISTORY_PATH",
            str(claude_home / "history.jsonl"),
        )
    )
    session_env_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_CLAUDE_SESSION_ENV_DIR",
            str(claude_home / "session-env"),
        )
    )
    app_sessions_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_CLAUDE_APP_SESSIONS_DIR",
            str(Path.home() / "Library" / "Application Support" / "Claude" / "claude-code-sessions"),
        )
    )
    return ClaudeHistoryPaths(
        home=claude_home,
        projects_dir=projects_dir,
        history_path=history_path,
        session_env_dir=session_env_dir,
        app_sessions_dir=app_sessions_dir,
    )


def get_gemini_history_paths() -> GeminiHistoryPaths:
    gemini_home = _expand_path(
        os.environ.get(
            "HARNESSARENA_GEMINI_HOME",
            "~/.gemini",
        )
    )
    tmp_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_GEMINI_TMP_DIR",
            str(gemini_home / "tmp"),
        )
    )
    skills_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_GEMINI_SKILLS_DIR",
            str(gemini_home / "skills"),
        )
    )
    agents_skills_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_AGENTS_SKILLS_DIR",
            str(Path.home() / ".agents" / "skills"),
        )
    )
    return GeminiHistoryPaths(
        home=gemini_home,
        tmp_dir=tmp_dir,
        skills_dir=skills_dir,
        agents_skills_dir=agents_skills_dir,
    )


def get_cursor_history_paths() -> CursorHistoryPaths:
    cursor_home = _expand_path(
        os.environ.get(
            "HARNESSARENA_CURSOR_HOME",
            "~/.cursor",
        )
    )
    chats_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_CURSOR_CHATS_DIR",
            str(cursor_home / "chats"),
        )
    )
    return CursorHistoryPaths(
        home=cursor_home,
        chats_dir=chats_dir,
    )


def get_opencode_history_paths() -> OpenCodeHistoryPaths:
    opencode_home = _expand_path(
        os.environ.get(
            "HARNESSARENA_OPENCODE_HOME",
            str(Path.home() / ".local" / "share" / "opencode"),
        )
    )
    db_path = _expand_path(
        os.environ.get(
            "HARNESSARENA_OPENCODE_DB_PATH",
            str(opencode_home / "opencode.db"),
        )
    )
    config_dir = _expand_path(
        os.environ.get(
            "HARNESSARENA_OPENCODE_CONFIG_DIR",
            str(Path.home() / ".config" / "opencode"),
        )
    )
    package_json_path = _expand_path(
        os.environ.get(
            "HARNESSARENA_OPENCODE_PACKAGE_JSON_PATH",
            str(config_dir / "package.json"),
        )
    )
    return OpenCodeHistoryPaths(
        home=opencode_home,
        db_path=db_path,
        config_dir=config_dir,
        package_json_path=package_json_path,
    )
