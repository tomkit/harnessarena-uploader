from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from ..base_parser import HarnessParser
from ..history_paths import get_codex_history_paths
from ..metric_strategies import (
    ConstantSessionsMetricStrategy,
    HarnessMetricStrategies,
    SnapshotCostMetricStrategy,
    SnapshotDailyMetricStrategy,
    SnapshotMCPMetricStrategy,
    SnapshotPlanMetricStrategy,
    SnapshotPromptMetricStrategy,
    SnapshotSkillMetricStrategy,
    SnapshotSubagentMetricStrategy,
    SnapshotTokenMetricStrategy,
    SnapshotToolMetricStrategy,
)
from ..helpers import _basename_only, _make_session_id, _parse_timestamp, _safe_int
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


class CodexParser(HarnessParser):
    """Codex CLI session parser.

    Codex JSONL stores events as {type, payload, timestamp} envelopes.
    Tool calls appear as response_item with payload.type == "function_call"
    and payload.name == tool name (e.g. "shell", "read_file").
    Plugins registered in ~/.codex/config.toml provide MCP tools
    (e.g. github@openai-curated → mcp__codex_apps__github_*).
    """

    harness_type = Harness.CODEX

    def __init__(self) -> None:
        self._paths = get_codex_history_paths()
        # Build plugin registry from config.toml
        self._plugin_names: set[str] = set()
        config_path = self._paths.config_path
        if config_path.is_file():
            try:
                with open(config_path, "r") as f:
                    for line in f:
                        # Parse [plugins."name@source"] sections
                        line = line.strip()
                        if line.startswith("[plugins."):
                            name = line.split('"')[1] if '"' in line else ""
                            if name:
                                self._plugin_names.add(name.split("@")[0])
            except OSError:
                pass
        self._strategies = HarnessMetricStrategies(
            sessions=ConstantSessionsMetricStrategy(),
            prompts=SnapshotPromptMetricStrategy(),
            subagents=SnapshotSubagentMetricStrategy(),
            mcp=SnapshotMCPMetricStrategy(),
            skills=SnapshotSkillMetricStrategy(),
            tools=SnapshotToolMetricStrategy(),
            tokens=SnapshotTokenMetricStrategy(),
            plan=SnapshotPlanMetricStrategy(),
            daily=SnapshotDailyMetricStrategy(),
            cost=SnapshotCostMetricStrategy(),
        )

    def detect_skill(self, tool_name: str, tool_input: dict) -> Optional[str]:
        # Codex plugin tools appear as mcp__codex_apps__<plugin>_<action>
        if tool_name.startswith("mcp__codex_apps__"):
            parts = tool_name.split("__")
            if len(parts) >= 3:
                plugin_tool = parts[2]  # e.g. "github_get_profile"
                plugin_name = plugin_tool.split("_")[0]  # e.g. "github"
                if plugin_name in self._plugin_names:
                    return plugin_name
        return None

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_codex(since, parser=self)

    def metric_strategies(self) -> HarnessMetricStrategies:
        return self._strategies


def _register_mcp_tool(mcp_servers: dict[str, dict], tool_name: str) -> None:
    if not tool_name.startswith("mcp__"):
        return
    remainder = tool_name[len("mcp__") :]
    server_name = remainder
    primitive_name = tool_name
    if "__" in remainder:
        server_name, primitive_name = remainder.split("__", 1)
    elif "_" in remainder:
        server_name, primitive_name = remainder.split("_", 1)
    server = mcp_servers.setdefault(
        server_name,
        {"invocation_count": 0, "uri": None, "primitives": {}},
    )
    server["invocation_count"] += 1
    primitive = server["primitives"].setdefault(
        primitive_name,
        {"primitive_type": "tool", "invocation_count": 0},
    )
    primitive["invocation_count"] += 1


def _parse_codex(since: Optional[datetime] = None, parser: Optional[HarnessParser] = None) -> list[SessionMeta]:
    """Parse Codex SQLite database + JSONL session files.

    SQLite: ~/.codex/state_5.sqlite table `threads`
    Sessions: ~/.codex/sessions/{y}/{m}/{d}/rollout-*.jsonl
    """
    db_path = parser._paths.state_db_path
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
                   cli_version, git_sha, git_branch, created_at,
                   sandbox_policy
            FROM threads
        """
        params: list = []
        if since:
            query += " WHERE created_at >= ?"
            params.append(int(since.replace(tzinfo=timezone.utc).timestamp()))

        cursor.execute(query, params)
        thread_rows = cursor.fetchall()

        # Count subagent spawns per parent thread from thread_spawn_edges
        spawn_counts: dict[str, int] = {}
        try:
            edges = cursor.execute(
                "SELECT parent_thread_id, COUNT(*) as cnt FROM thread_spawn_edges GROUP BY parent_thread_id"
            ).fetchall()
            for e in edges:
                spawn_counts[str(e["parent_thread_id"])] = e["cnt"]
        except sqlite3.OperationalError:
            pass  # table may not exist in older versions

        for row in thread_rows:
            source_id = str(row["id"])
            model = row["model"] if row["model"] else "unknown"
            total_tokens = _safe_int(row["tokens_used"])
            project_name = _basename_only(row["cwd"])
            git_branch = row["git_branch"]
            harness_version = row["cli_version"]
            started_at = _parse_timestamp(row["created_at"])

            # Detect plan mode from sandbox_policy: read-only = plan mode
            plan_entries = 0
            try:
                sandbox = json.loads(row["sandbox_policy"]) if row["sandbox_policy"] else {}
                if isinstance(sandbox, dict) and sandbox.get("type") == "read-only":
                    plan_entries = 1
            except (json.JSONDecodeError, TypeError):
                pass

            # Subagent count from thread_spawn_edges
            sub_count = spawn_counts.get(source_id, 0)

            results.append(parser.session_from_snapshot({
                "id": _make_session_id(Harness.CODEX, source_id),
                "source_session_id": source_id,
                "harness_version": str(harness_version) if harness_version else None,
                "project_name": project_name,
                "git_repo_name": project_name,
                "git_branch": git_branch,
                "model": model,
                "provider": "openai",
                "tokens": TokenUsage(total_tokens=total_tokens),
                "subagent_calls": sub_count,
                "plan_mode_entries": plan_entries,
                "plan_mode_exits": plan_entries,
                "started_at": started_at,
            }))

        conn.close()
    except sqlite3.Error:
        pass

    # Enrich sessions from JSONL rollout files
    # Codex JSONL format: {type, payload, timestamp} envelopes
    #   type=session_meta — has payload.id matching SQLite thread ID
    #   type=response_item, payload.type=message, payload.role=user/assistant
    #   type=response_item, payload.type=function_call, payload.name=tool_name
    session_lookup = {s.source_session_id: i for i, s in enumerate(results)}
    sessions_dir = parser._paths.sessions_dir
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
                skill_invocations: dict[str, int] = {}
                mcp_servers: dict[str, dict] = {}
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
                                        _register_mcp_tool(mcp_servers, tool_name)
                                    if c["skill_name"]:
                                        skill_invocations[c["skill_name"]] = skill_invocations.get(c["skill_name"], 0) + 1
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
                    d["subagent_calls"] = max(old.subagent_calls, subagent_calls)
                    d["background_agents"] = background_agents
                    d["mcp_calls"] = mcp_calls
                    d["plan_mode_entries"] = max(old.plan_mode_entries, plan_mode_entries)
                    d["plan_mode_exits"] = max(old.plan_mode_exits, plan_mode_exits)
                    d["tool_calls"] = tuple(
                        ToolCallSummary(n, c) for n, c in sorted(tool_names.items())
                    )
                    d["skills_used"] = {
                        name: {"count": count, "source": "plugin"}
                        for name, count in skill_invocations.items()
                    }
                    d["mcp_servers"] = {
                        **getattr(old, "mcp_servers", {}),
                        **{
                            name: {
                                "count": info["invocation_count"],
                                "uri": info.get("uri"),
                                "primitives": [
                                    {
                                        "name": primitive_name,
                                        "type": primitive_info.get("primitive_type", "tool"),
                                        "count": primitive_info.get("invocation_count", 0),
                                    }
                                    for primitive_name, primitive_info in sorted(info["primitives"].items())
                                ],
                            }
                            for name, info in sorted(mcp_servers.items())
                        },
                    }
                    results[idx] = SessionMeta(**d)

            except (OSError, PermissionError):
                continue

    return results
