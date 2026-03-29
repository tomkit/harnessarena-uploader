from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..helpers import _basename_only, _make_session_id, _parse_timestamp, _safe_int
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


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
