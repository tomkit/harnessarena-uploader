from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..history_paths import get_claude_history_paths
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
from ..helpers import (
    _basename_only,
    _decode_claude_project_dir,
    _extract_user_display_text,
    _make_prompt_key,
    _make_session_id,
)
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


class ClaudeParser(HarnessParser):
    """Claude Code session parser."""

    harness_type = Harness.CLAUDE

    def __init__(self) -> None:
        self._paths = get_claude_history_paths()
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
        return _parse_claude(since, parser=self, paths=self._paths)

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


def _parse_claude(
    since: Optional[datetime] = None,
    parser: Optional[HarnessParser] = None,
    paths=None,
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
    paths = paths or get_claude_history_paths()
    projects_dir = paths.projects_dir
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

                        results.append(parser.session_from_snapshot({
                            "id": _make_session_id(Harness.CLAUDE, source_id),
                            "source_session_id": source_id,
                            "harness_version": None,
                            "project_name": idx_project,
                            "git_repo_name": idx_project,
                            "git_branch": entry.get("gitBranch"),
                            "model": "unknown",
                            "provider": "anthropic",
                            "message_count_user": 0,
                            "message_count_assistant": 0,
                            "message_count_total": msg_count,
                            "tool_call_count": 0,
                            "tokens": TokenUsage(),
                            "data_completeness": "partial",
                            "is_pruned": True,
                            "started_at": created,
                            "ended_at": modified,
                            "duration_seconds": duration,
                        }))
                        seen_session_ids.add(source_id)
                except Exception:
                    continue

    # --- Source 1c: history.jsonl — global prompt log (fills gaps for pruned sessions) ---
    # history.jsonl records every user prompt with project path + timestamp.
    # Most complete record of prompt counts, even when JSONL files are pruned.
    # We dedup against JSONL sessions using text[:100] + 5s-bucketed timestamp
    # as a shared key — only prompts NOT already seen in JSONL are counted.
    history_file = paths.history_path
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
            results.append(parser.session_from_snapshot({
                "id": _make_session_id(Harness.CLAUDE, source_id),
                "source_session_id": source_id,
                "harness_version": None,
                "project_name": proj_name,
                "git_repo_name": proj_name,
                "git_branch": None,
                "model": "unknown",
                "provider": "anthropic",
                "message_count_user": len(timestamps),
                "message_count_assistant": 0,
                "message_count_total": len(timestamps),
                "tool_call_count": 0,
                "tokens": TokenUsage(),
                "data_completeness": "prompts_only",
                "is_pruned": True,
                "started_at": f"{first_day}T00:00:00Z",
                "ended_at": f"{last_day}T23:59:59Z",
                "duration_seconds": None,
            }))
            seen_session_ids.add(source_id)

    # --- Source 2: Session metadata in Application Support (fallback) ---
    for sessions_dir in [
        paths.app_sessions_dir,
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

                results.append(parser.session_from_snapshot({
                    "id": _make_session_id(Harness.CLAUDE, source_id),
                    "source_session_id": source_id,
                    "harness_version": None,
                    "project_name": _basename_only(data.get("cwd") or data.get("originCwd")),
                    "git_repo_name": None,
                    "git_branch": None,
                    "model": data.get("model", "unknown"),
                    "provider": "anthropic",
                    "message_count_user": 0,
                    "message_count_assistant": 0,
                    "message_count_total": 0,
                    "tool_call_count": 0,
                    "tokens": TokenUsage(),
                    "started_at": started_at,
                    "ended_at": ended_at,
                    "duration_seconds": duration,
                }))
                seen_session_ids.add(source_id)
            except Exception:
                continue

    return results


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
    session_id = jsonl_path.stem  # filename without .jsonl
    prompt_keys: set[str] = set()  # dedup keys for user prompts
    versions: set[str] = set()
    models: Counter = Counter()
    user_count = 0
    assistant_count = 0
    total_count = 0
    tool_call_count = 0
    subagent_calls = 0
    # Execution time tracking: measure harness work time between user prompts
    turn_exec_times: list[float] = []
    _last_user_ts: datetime | None = None
    _last_nonuser_ts: datetime | None = None
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
    mcp_servers: dict[str, dict] = {}
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
                # Track execution time: gap from user prompt to last response
                if _last_user_ts and _last_nonuser_ts and timestamp:
                    try:
                        exec_time = (_last_nonuser_ts - _last_user_ts).total_seconds()
                        if 0 < exec_time < 1800:  # cap at 30min (idle = user walked away)
                            turn_exec_times.append(exec_time)
                    except (TypeError, ValueError):
                        pass
                if timestamp:
                    try:
                        _last_user_ts = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                _last_nonuser_ts = None

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
                if timestamp:
                    try:
                        _last_nonuser_ts = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    except ValueError:
                        pass
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
                                _register_mcp_tool(mcp_servers, tool_name)
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
                if timestamp:
                    try:
                        _last_nonuser_ts = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                total_count += 1
                # Detect marketplace plugins from hook summaries
                # Plugin paths appear in hookInfos.command (may use ${CLAUDE_PLUGIN_ROOT})
                # or in hookErrors (contains resolved full paths)
                subtype = entry.get("subtype", "")
                if subtype == "stop_hook_summary":
                    # Check both hookInfos commands and hookErrors for plugin paths
                    texts_to_check = []
                    for hook in entry.get("hookInfos", []):
                        texts_to_check.append(hook.get("command", ""))
                    for err in entry.get("hookErrors", []):
                        if isinstance(err, str):
                            texts_to_check.append(err)
                    for text in texts_to_check:
                        if "claude-plugins-official/" in text:
                            idx = text.find("claude-plugins-official/")
                            remainder = text[idx + len("claude-plugins-official/"):]
                            plugin_name = remainder.split("/")[0]
                            if plugin_name and plugin_name not in ("hooks", "plugins", ""):
                                skill_invocations[plugin_name] += 1
                                break  # one detection per hook entry

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
                                            _register_mcp_tool(mcp_servers, tool_name)
                                            if date:
                                                _add_daily(date, mcp_calls=1)
                                    elif tool_name.startswith("mcp__"):
                                        mcp_calls += 1
                                        _register_mcp_tool(mcp_servers, tool_name)
                                        if date:
                                            _add_daily(date, mcp_calls=1)
                        elif entry_type == "user":
                            # Subagent "user" entries are system-generated
                            # (parent agent sending tasks), not human prompts.
                            # Count for total messages but NOT as user prompts.
                            total_count += 1
                        elif entry_type == "system":
                            # Detect marketplace plugins from hook summaries in subagents
                            subtype = entry.get("subtype", "")
                            if subtype == "stop_hook_summary":
                                for hook in entry.get("hookInfos", []):
                                    cmd = hook.get("command", "")
                                    if "claude-plugins-official/" in cmd or "plugins/cache/" in cmd:
                                        parts = cmd.split("/")
                                        for i, p in enumerate(parts):
                                            if p in ("claude-plugins-official", "cache") and i + 1 < len(parts):
                                                plugin_name = parts[i + 1]
                                                if plugin_name and plugin_name not in ("hooks",):
                                                    skill_invocations[plugin_name] += 1
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

    # Capture last turn execution time (user → end of session)
    if _last_user_ts and _last_nonuser_ts:
        try:
            exec_time = (_last_nonuser_ts - _last_user_ts).total_seconds()
            if 0 < exec_time < 1800:
                turn_exec_times.append(exec_time)
        except (TypeError, ValueError):
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
    # Mark first date as having 1 session
    if first_ts:
        first_date = _get_date(first_ts)
        if first_date and first_date in daily_data:
            daily_data[first_date]["sessions"] = 1

    daily_list = sorted(daily_data.values(), key=lambda d: d["date"])

    return parser.session_from_snapshot({
        "id": _make_session_id(Harness.CLAUDE, session_id),
        "source_session_id": session_id,
        "harness_version": harness_version,
        "project_name": project_name,
        "git_repo_name": project_name,
        "git_branch": None,
        "model": top_model,
        "provider": "anthropic",
        "message_count_user": user_count,
        "message_count_assistant": assistant_count,
        "message_count_total": total_count,
        "tool_call_count": tool_call_count,
        "subagent_calls": subagent_calls,
        "background_agents": background_agents,
        "mcp_calls": mcp_calls,
        "mcp_servers": mcp_servers,
        "plan_mode_entries": plan_mode_entries,
        "plan_mode_exits": plan_mode_exits,
        "tokens": TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            total_tokens=total_tokens,
        ),
        "tool_calls": tool_summaries,
        "skills_used": skills,
        "daily": daily_list,
        "cost_usd": None,
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_seconds": duration,
        # Harness execution time derived from timestamp gaps
        "total_exec_seconds": round(sum(turn_exec_times), 1) if turn_exec_times else None,
        "mean_turn_seconds": round(sum(turn_exec_times) / len(turn_exec_times), 1) if turn_exec_times else None,
        "median_turn_seconds": round(sorted(turn_exec_times)[len(turn_exec_times) // 2], 1) if turn_exec_times else None,
    }), prompt_keys
