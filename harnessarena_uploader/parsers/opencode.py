from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..history_paths import get_opencode_history_paths
from ..metric_strategies import HarnessMetricStrategies
from ..helpers import _basename_only, _make_session_id, _parse_timestamp, _register_mcp_tool, _safe_int
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary
from ..trackers import TimeSpanTracker, PlanModeTracker


class OpenCodeParser(HarnessParser):
    """OpenCode session parser.

    OpenCode stores sessions in SQLite (Drizzle ORM). Tool calls appear in the
    `part` table with type in (tool-call, tool_use, function_call) and toolName.
    """

    harness_type = Harness.OPENCODE

    def __init__(self) -> None:
        self._paths = get_opencode_history_paths()
        self._strategies = HarnessMetricStrategies.snapshot_defaults()

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_opencode(since, parser=self, paths=self._paths)

    def metric_strategies(self) -> HarnessMetricStrategies:
        return self._strategies


def _parse_opencode(
    since: Optional[datetime] = None,
    parser: Optional[HarnessParser] = None,
    paths=None,
) -> list[SessionMeta]:
    """Parse OpenCode SQLite database.

    Path: ~/.local/share/opencode/opencode.db
    Tables:
      session: id, project_id, title, directory, time_created
      message: id, session_id, data JSON with role/model/tokens/cost
      part: id, message_id, data JSON with type/text
    """
    paths = paths or get_opencode_history_paths()
    db_path = paths.db_path
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
            parent_id = str(session_row["parent_id"]) if session_row["parent_id"] else None
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
            # Track agent/mode from message data for plan mode + skill detection
            agent_names: set[str] = set()
            skill_invocations: dict[str, int] = {}

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

                # Track agent name for plan mode and subagent detection
                # "build" = normal, "plan" = plan mode, other = custom agent (not a skill)
                agent_name = data.get("agent", "")
                if agent_name and agent_name not in ("build", ""):
                    agent_names.add(agent_name)

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

            # Build time spans from message timestamps
            time_tracker = TimeSpanTracker()
            plan_tracker = PlanModeTracker()
            _in_plan_mode = False
            for msg_row2 in cursor.execute(
                "SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
                (session_row["id"],),
            ).fetchall():
                try:
                    mdata = json.loads(msg_row2["data"]) if isinstance(msg_row2["data"], str) else {}
                except json.JSONDecodeError:
                    continue
                msg_dt = datetime.fromtimestamp(msg_row2["time_created"] / 1000, tz=timezone.utc)
                msg_role = mdata.get("role", "")
                msg_agent = mdata.get("agent", "")
                if msg_role == "user":
                    time_tracker.on_user_turn(msg_dt)
                elif msg_role == "assistant":
                    time_tracker.on_nonuser_event(msg_dt)
                # Track plan mode transitions by agent field changes
                if msg_agent == "plan" and not _in_plan_mode:
                    _in_plan_mode = True
                    plan_tracker.on_enter(msg_dt)
                elif msg_agent != "plan" and _in_plan_mode:
                    _in_plan_mode = False
                    plan_tracker.on_exit(msg_dt)

            if _in_plan_mode and time_tracker._last_nonuser_ts:
                plan_tracker.on_exit(time_tracker._last_nonuser_ts)

            time_spans, turn_exec_times = time_tracker.finalize()
            # Add plan mode spans
            for ps in plan_tracker.spans:
                time_spans.append(ps)
            # Replace harness_exec with plan_mode for session-level plan
            plan_tracker.replace_session_level(
                time_spans, max(plan_entries, int("plan" in agent_names))
            )

            # Count tool-type parts and extract tool spans
            cursor.execute(
                """SELECT p.data FROM part p
                   JOIN message m ON p.message_id = m.id
                   WHERE m.session_id = ?""",
                (session_row["id"],),
            )
            tool_call_count = 0
            tool_counts: dict[str, int] = {}
            tool_categories: dict[str, str] = {}
            subagent_calls = 0
            background_agents = 0
            mcp_calls = 0
            plan_mode_entries = 0
            plan_mode_exits = 0
            mcp_servers: dict[str, dict] = {}
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
                # Detect skill invocations: tool="skill" with state.input.name
                if is_tool and tool_name == "skill":
                    state = pdata.get("state", {})
                    if isinstance(state, dict):
                        meta = state.get("metadata", {}) or {}
                        skill_name = (state.get("input", {}) or {}).get("name") or meta.get("name", "")
                        if skill_name:
                            # Determine source from metadata.dir path
                            skill_dir = meta.get("dir", "")
                            if ".claude/skills/" in skill_dir:
                                source = "user-custom"
                            elif "/.opencode/" in skill_dir or "plugins" in skill_dir:
                                source = "marketplace"
                            else:
                                source = "user-custom"
                            skill_invocations[skill_name] = {"count": skill_invocations.get(skill_name, {}).get("count", 0) + 1, "source": source}

                if is_tool:
                    tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
                    tool_call_count += 1
                    # Classify tool category
                    if tool_name == "skill":
                        tool_categories[tool_name] = "skill"
                    elif tool_name == "task":
                        tool_categories[tool_name] = "subagent"
                    elif tool_name.startswith("mcp_") or tool_name.startswith("mcp__"):
                        tool_categories[tool_name] = "mcp"
                    else:
                        tool_categories.setdefault(tool_name, "tool")
                    # Extract tool span timing from state.time
                    state = pdata.get("state", {})
                    if isinstance(state, dict):
                        time_info = state.get("time", {})
                        if isinstance(time_info, dict) and time_info.get("start") and time_info.get("end"):
                            try:
                                t_start = datetime.fromtimestamp(time_info["start"] / 1000, tz=timezone.utc)
                                t_end = datetime.fromtimestamp(time_info["end"] / 1000, tz=timezone.utc)
                                dur = (t_end - t_start).total_seconds()
                                if dur >= 0:
                                    # Find which harness_exec span this tool falls in and add to its tool_spans
                                    for sp in time_spans:
                                        if sp.get("type") == "harness_exec" or sp.get("type") == "plan_mode":
                                            sp_start = datetime.fromisoformat(sp["start"])
                                            sp_end = datetime.fromisoformat(sp["end"])
                                            if sp_start <= t_start <= sp_end:
                                                if "tool_spans" not in sp:
                                                    sp["tool_spans"] = []
                                                sp["tool_spans"].append({
                                                    "name": tool_name,
                                                    "category": "tool",
                                                    "start": t_start.isoformat(),
                                                    "end": t_end.isoformat(),
                                                    "seconds": round(dur, 3),
                                                })
                                                break
                            except (TypeError, ValueError, OSError):
                                pass
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
                            _register_mcp_tool(mcp_servers, tool_name)
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

            results.append(parser.session_from_snapshot({
                "id": _make_session_id(Harness.OPENCODE, session_id),
                "source_session_id": session_id,
                "parent_session_id": parent_id,
                "agent_name": next((a for a in agent_names if a != "plan"), None) if parent_id else None,
                "harness_version": None,
                "project_name": project_name,
                "git_repo_name": project_name,
                "git_branch": None,
                "model": model,
                "provider": provider,
                "message_count_user": user_count,
                "message_count_assistant": assistant_count,
                "message_count_total": total_count,
                "tool_call_count": tool_call_count,
                "tokens": TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=input_tokens + output_tokens,
                ),
                "subagent_calls": max(subagent_calls, spawn_counts.get(session_id, 0)),
                "background_agents": background_agents,
                "mcp_calls": mcp_calls,
                "mcp_servers": mcp_servers,
                "plan_mode_entries": max(plan_entries, plan_mode_entries, int("plan" in agent_names)),
                "plan_mode_exits": max(plan_entries, plan_mode_exits, int("plan" in agent_names)),
                "tool_calls": tuple(
                    ToolCallSummary(name, count, tool_categories.get(name, "tool"))
                    for name, count in sorted(tool_counts.items())
                ),
                "skills_used": skill_invocations,
                "cost_usd": cost if cost > 0 else None,
                "started_at": started_at,
                "ended_at": ended_at if ended_at else None,
                "duration_seconds": duration,
                "time_spans": time_spans,
                "total_exec_seconds": round(sum(t for t in turn_exec_times), 1) if turn_exec_times else None,
                "mean_turn_seconds": round(sum(turn_exec_times) / len(turn_exec_times), 1) if turn_exec_times else None,
                "median_turn_seconds": round(sorted(turn_exec_times)[len(turn_exec_times) // 2], 1) if turn_exec_times else None,
            }))

        conn.close()
    except sqlite3.Error:
        pass

    return results
