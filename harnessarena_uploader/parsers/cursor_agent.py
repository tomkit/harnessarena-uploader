from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..helpers import _make_session_id
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


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

                # Detect plan mode from meta.mode field
                session_mode = raw.get("mode", "default")
                is_plan_mode = session_mode == "plan"

                # Parse blobs for message counts, tool calls, and token estimation.
                # Cursor Agent doesn't report token counts, so we estimate:
                # ~4 chars per token for English text.
                _CHARS_PER_TOKEN = 4
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
                estimated_input_tokens = 0
                estimated_output_tokens = 0

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
                        # Estimate tokens from content length
                        content = msg.get("content", "")
                        content_len = 0
                        if isinstance(content, str):
                            content_len = len(content)
                        elif isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict):
                                    content_len += len(block.get("text", ""))

                        if role == "user":
                            user_count += 1
                            estimated_input_tokens += content_len // _CHARS_PER_TOKEN
                        elif role == "assistant":
                            assistant_count += 1
                            estimated_output_tokens += content_len // _CHARS_PER_TOKEN
                        elif role == "tool":
                            # Tool results count as input context
                            estimated_input_tokens += content_len // _CHARS_PER_TOKEN
                        elif role == "system":
                            estimated_input_tokens += content_len // _CHARS_PER_TOKEN
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
                    plan_mode_entries=max(int(is_plan_mode), plan_mode_entries),
                    plan_mode_exits=max(int(is_plan_mode), plan_mode_exits),
                    tokens=TokenUsage(
                        input_tokens=estimated_input_tokens,
                        output_tokens=estimated_output_tokens,
                        total_tokens=estimated_input_tokens + estimated_output_tokens,
                    ),
                    tool_calls=tuple(
                        ToolCallSummary(n, c) for n, c in sorted(tool_names.items())
                    ),
                    started_at=started_at,
                ))

            except Exception as _exc:
                continue

    return results
