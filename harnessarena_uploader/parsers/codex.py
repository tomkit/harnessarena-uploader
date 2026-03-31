from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from ..base_parser import HarnessParser
from ..history_paths import get_codex_history_paths
from ..metric_strategies import HarnessMetricStrategies
from ..helpers import _basename_only, _make_session_id, _parse_timestamp, _register_mcp_tool, _safe_int
from ..models import Harness, SessionMeta, SubagentMeta, TokenUsage, ToolCallSummary
from ..trackers import PlanModeTracker, SubagentCollector, TimeSpanTracker, ToolClassifier


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
        self._strategies = HarnessMetricStrategies.snapshot_defaults()

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        return tool_name == "spawn_agent"

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
                last_token_usage: Optional[dict] = None
                _prev_nc_in: int = 0  # previous cumulative non-cached input
                _prev_out: int = 0    # previous cumulative output
                jsonl_session_id: Optional[str] = None
                jsonl_project: Optional[str] = None
                jsonl_version: Optional[str] = None
                jsonl_started: Optional[str] = None

                # Tracker instances
                time_tracker = TimeSpanTracker()
                plan_tracker = PlanModeTracker()
                tool_classifier = ToolClassifier()
                subagent_collector = SubagentCollector()

                # Subagent metadata from session_meta
                _is_subagent = False
                _agent_nickname = ""
                _agent_role = ""
                _agent_depth = 0
                _forked_from_id: Optional[str] = None

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

                        entry_ts = entry.get("timestamp")
                        entry_dt: Optional[datetime] = None
                        if entry_ts:
                            try:
                                entry_dt = datetime.fromisoformat(entry_ts.replace("Z", "+00:00"))
                            except (ValueError, TypeError):
                                pass

                        if entry_type == "session_meta":
                            if jsonl_session_id is None:  # only take first session_meta
                                jsonl_session_id = payload.get("id")
                                # Capture subagent metadata if this is a forked session
                                if payload.get("forked_from_id"):
                                    _is_subagent = True
                                    _forked_from_id = payload.get("forked_from_id")
                                    _agent_nickname = payload.get("agent_nickname", "")
                                    _agent_role = payload.get("agent_role", "")
                                    source = payload.get("source", {})
                                    if isinstance(source, dict):
                                        spawn = source.get("subagent", {}).get("thread_spawn", {})
                                        _agent_depth = spawn.get("depth", 1)
                            jsonl_project = _basename_only(payload.get("cwd"))
                            jsonl_version = payload.get("cli_version")
                            jsonl_started = _parse_timestamp(payload.get("timestamp"))
                        elif entry_type == "response_item":
                            ptype = payload.get("type", "")
                            if ptype == "message":
                                role = payload.get("role", "")
                                if role == "user":
                                    user_count += 1
                                    # Track turn boundary for time spans
                                    if entry_dt:
                                        time_tracker.on_user_turn(entry_dt)
                                elif role == "assistant":
                                    assistant_count += 1
                                    if entry_dt:
                                        time_tracker.on_nonuser_event(entry_dt)
                                total_count += 1
                            elif ptype == "function_call":
                                tool_name = payload.get("name", "unknown")
                                tool_count += 1

                                # Classify via tracker
                                category = tool_classifier.record(
                                    tool_name, {}, parser,
                                    timestamp_dt=entry_dt,
                                    plan_tracker=plan_tracker,
                                )

                                # Codex-specific: capture spawn_agent metadata
                                if parser:
                                    c = parser.classify_tool_call(tool_name, {})
                                    if c["is_subagent"] and tool_name == "spawn_agent":
                                        spawn_args = {}
                                        try:
                                            spawn_args = json.loads(payload.get("arguments", "{}"))
                                        except (json.JSONDecodeError, TypeError):
                                            pass
                                        subagent_collector.record_spawn(
                                            subagent_type=spawn_args.get("agent_type", ""),
                                        )

                                # Track tool call start
                                call_id = payload.get("call_id", "")
                                if call_id and entry_dt:
                                    time_tracker.on_tool_start(call_id, tool_name, category, entry_dt)
                            elif ptype == "function_call_output":
                                # Match tool call end
                                call_id = payload.get("call_id", "")
                                if call_id and entry_dt:
                                    tool_span = time_tracker.on_tool_end(call_id, entry_dt)
                                    if tool_span:
                                        plan_tracker.on_tool_span(tool_span)
                                if entry_dt:
                                    time_tracker.on_nonuser_event(entry_dt)
                        elif entry_type == "event_msg":
                            total_count += 1
                            evt_type = payload.get("type")
                            if evt_type == "token_count":
                                info = payload.get("info", {})
                                if isinstance(info, dict):
                                    ttu = info.get("total_token_usage")
                                    if isinstance(ttu, dict):
                                        last_token_usage = ttu
                                        # Compute non-cached token delta for per-span attribution
                                        cur_nc_in = max(0, _safe_int(ttu.get("input_tokens")) - _safe_int(ttu.get("cached_input_tokens")))
                                        cur_out = _safe_int(ttu.get("output_tokens"))
                                        delta_in = max(0, cur_nc_in - _prev_nc_in)
                                        delta_out = max(0, cur_out - _prev_out)
                                        if delta_in > 0 or delta_out > 0:
                                            time_tracker.on_tokens(delta_in, delta_out)
                                        _prev_nc_in = cur_nc_in
                                        _prev_out = cur_out
                            elif evt_type == "exec_command_start":
                                call_id = payload.get("call_id", "")
                                if call_id and entry_dt:
                                    time_tracker.on_tool_start("exec:" + call_id, "exec_command", "tool", entry_dt)
                            elif evt_type == "exec_command_end":
                                call_id = payload.get("call_id", "")
                                key = "exec:" + call_id
                                if entry_dt:
                                    time_tracker.on_tool_end(key, entry_dt)
                                if entry_dt:
                                    time_tracker.on_nonuser_event(entry_dt)
                            elif evt_type == "task_started":
                                # New turn boundary — emit previous turn's span
                                if entry_dt:
                                    time_tracker.on_user_turn(entry_dt)

                        # Capture last turn
                        if entry_type == "event_msg" and entry_dt:
                            time_tracker.on_nonuser_event(entry_dt)

                # Finalize time spans
                time_spans, _ = time_tracker.finalize()
                # Append plan mode spans
                time_spans.extend(plan_tracker.spans)

                # If session-level plan mode and no explicit plan spans, replace harness_exec with plan_mode
                is_session_plan = False
                if jsonl_session_id and jsonl_session_id in session_lookup:
                    is_session_plan = results[session_lookup[jsonl_session_id]].plan_mode_entries > 0
                plan_tracker.replace_session_level(time_spans, 1 if is_session_plan else 0)

                # Enrich matching SQLite session, or create standalone
                if jsonl_session_id and jsonl_session_id in session_lookup:
                    idx = session_lookup[jsonl_session_id]
                    old = results[idx]
                    d = {f.name: getattr(old, f.name) for f in old.__dataclass_fields__.values()}
                    d["message_count_user"] = user_count
                    d["message_count_assistant"] = assistant_count
                    d["message_count_total"] = total_count
                    d["tool_call_count"] = tool_count
                    if last_token_usage:
                        raw_in = _safe_int(last_token_usage.get("input_tokens"))
                        raw_out = _safe_int(last_token_usage.get("output_tokens"))
                        cached = _safe_int(last_token_usage.get("cached_input_tokens"))
                        # Normalize: input_tokens = non-cached input (Claude convention)
                        non_cached_in = max(0, raw_in - cached)
                        d["tokens"] = TokenUsage(
                            input_tokens=non_cached_in,
                            output_tokens=raw_out,
                            cache_read_tokens=cached,
                            cache_write_tokens=0,
                            total_tokens=non_cached_in + raw_out,
                        )
                    if time_spans:
                        d["time_spans"] = time_spans
                    if _forked_from_id:
                        d["parent_session_id"] = _forked_from_id
                        d["agent_name"] = _agent_nickname or _agent_role or None
                    d["subagent_calls"] = max(old.subagent_calls, tool_classifier.subagent_calls)
                    d["background_agents"] = tool_classifier.background_agents
                    d["mcp_calls"] = tool_classifier.mcp_calls
                    d["plan_mode_entries"] = max(old.plan_mode_entries, plan_tracker.entries)
                    d["plan_mode_exits"] = max(old.plan_mode_exits, plan_tracker.exits)
                    d["tool_calls"] = tuple(
                        ToolCallSummary(n, c, tool_classifier.tool_categories.get(n, "tool")) for n, c in sorted(tool_classifier.tool_names.items())
                    )
                    d["skills_used"] = {
                        name: {"count": count, "source": "plugin"}
                        for name, count in tool_classifier.skill_invocations.items()
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
                            for name, info in sorted(tool_classifier.mcp_servers.items())
                        },
                    }
                    # Add subagent metadata (from spawn_agent calls in this session)
                    if len(subagent_collector) > 0:
                        d["subagents"] = subagent_collector.finalize()
                    results[idx] = SessionMeta(**d)

            except (OSError, PermissionError):
                continue

    # Enrich parent sessions' subagent metadata with nicknames from child session_metas
    # Build a map: parent_id → [(child_id, nickname, role, depth)]
    child_meta: dict[str, list[dict]] = {}
    try:
        conn = sqlite3.connect(str(parser._paths.state_db_path))
        conn.row_factory = sqlite3.Row
        edges = conn.execute(
            "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges ORDER BY rowid"
        ).fetchall()
        conn.close()
        for e in edges:
            pid = str(e["parent_thread_id"])
            cid = str(e["child_thread_id"])
            if pid not in child_meta:
                child_meta[pid] = []
            child_meta[pid].append({"child_id": cid})
    except (sqlite3.Error, OSError):
        pass

    # Match nicknames from child session JSONL files we already parsed
    # We stored nickname/role in local vars per file, but lost them.
    # Re-read just the first session_meta from child JSONL files for nicknames
    if sessions_dir.is_dir():
        for jsonl_file in sessions_dir.rglob("rollout-*.jsonl"):
            try:
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        entry = json.loads(line.strip())
                        if entry.get("type") == "session_meta":
                            p = entry.get("payload", {})
                            fid = p.get("forked_from_id")
                            if fid and fid in child_meta:
                                sid = p.get("id", "")
                                for cm in child_meta[fid]:
                                    if cm["child_id"] == sid:
                                        cm["nickname"] = p.get("agent_nickname", "")
                                        cm["role"] = p.get("agent_role", "")
                                        source = p.get("source", {})
                                        if isinstance(source, dict):
                                            cm["depth"] = source.get("subagent", {}).get("thread_spawn", {}).get("depth", 1)
                                        break
                            break  # only need first session_meta
            except (OSError, json.JSONDecodeError):
                continue

    # Now enrich parent sessions' SubagentMeta with nicknames
    for i, r in enumerate(results):
        children = child_meta.get(r.source_session_id, [])
        if not children and not r.subagents:
            continue
        # Build enriched subagent list
        enriched = list(r.subagents)
        for ci, cm in enumerate(children):
            if ci < len(enriched):
                # Update existing entry with nickname/depth
                old = enriched[ci]
                enriched[ci] = SubagentMeta(
                    ordinal=old.ordinal,
                    parent_ordinal=old.parent_ordinal,
                    mode=old.mode,
                    subagent_type=old.subagent_type or cm.get("role", ""),
                    nickname=cm.get("nickname", ""),
                    description=old.description,
                    depth=cm.get("depth", 1),
                    total_tokens=old.total_tokens,
                    total_tool_calls=old.total_tool_calls,
                )
            else:
                enriched.append(SubagentMeta(
                    ordinal=ci,
                    subagent_type=cm.get("role", ""),
                    nickname=cm.get("nickname", ""),
                    depth=cm.get("depth", 1),
                ))
        if enriched:
            d = {f.name: getattr(r, f.name) for f in r.__dataclass_fields__.values()}
            d["subagents"] = tuple(enriched)
            results[i] = SessionMeta(**d)

    return results
