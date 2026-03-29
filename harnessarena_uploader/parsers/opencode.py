from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..helpers import _basename_only, _make_session_id, _parse_timestamp, _safe_int
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


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
        query = "SELECT id, project_id, parent_id, title, directory, time_created, permission FROM session"
        params: list = []
        if since:
            query += " WHERE time_created >= ?"
            params.append(int(since.replace(tzinfo=timezone.utc).timestamp() * 1000))

        cursor.execute(query, params)
        sessions = cursor.fetchall()

        # Count subagent spawns per parent session
        # Sessions with non-null parent_id are subagent sessions
        spawn_counts: dict[str, int] = {}
        for s in sessions:
            parent = s["parent_id"]
            if parent:
                spawn_counts[str(parent)] = spawn_counts.get(str(parent), 0) + 1

        for session_row in sessions:
            session_id = str(session_row["id"])
            project_name = _basename_only(session_row["directory"])
            started_at = _parse_timestamp(session_row["time_created"])

            # Detect plan mode from permission field
            # OpenCode stores permissions as JSON array with plan_enter/plan_exit entries
            # action="allow" means plan mode is enabled for the session
            plan_entries = 0
            try:
                perms = json.loads(session_row["permission"]) if session_row["permission"] else []
                if isinstance(perms, list):
                    for perm in perms:
                        if isinstance(perm, dict) and perm.get("permission") == "plan_enter":
                            if perm.get("action") == "allow":
                                plan_entries = 1
            except (json.JSONDecodeError, TypeError):
                pass

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
                subagent_calls=max(subagent_calls, spawn_counts.get(session_id, 0)),
                background_agents=background_agents,
                mcp_calls=mcp_calls,
                plan_mode_entries=max(plan_entries, plan_mode_entries),
                plan_mode_exits=max(plan_entries, plan_mode_exits),
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
