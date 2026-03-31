from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..history_paths import get_gemini_history_paths
from ..metric_strategies import HarnessMetricStrategies
from ..helpers import _basename_only, _make_session_id, _register_mcp_tool, _safe_int
from ..models import Harness, SessionMeta, SubagentMeta, TokenUsage, ToolCallSummary
from ..trackers import TimeSpanTracker


class GeminiParser(HarnessParser):
    """Gemini CLI session parser.

    Gemini stores tool calls in msg.toolCalls array with {name, args, result}.
    Subagents appear as tool calls with name like "generalist", "cli_help", etc.
    Skills/extensions are installed at ~/.gemini/skills/ and ~/.agents/skills/.
    Thoughts/reasoning appear in msg.thoughts array and tokens.thoughts count.
    """

    harness_type = Harness.GEMINI

    # Gemini's built-in subagent tool names
    _SUBAGENT_TOOLS = {"generalist", "cli_help", "codebase_investigator"}

    # Built-in tools that are NOT skills
    _BUILTIN_TOOLS = {
        "read_file", "write_file", "run_shell_command", "replace",
        "list_directory", "grep", "grep_search", "generalist",
        "cli_help", "codebase_investigator",
    }

    def __init__(self) -> None:
        self._paths = get_gemini_history_paths()
        # Build skill registry from installed extensions/skills
        self._skill_names: set[str] = set()
        for skills_dir in [
            self._paths.skills_dir,
            self._paths.agents_skills_dir,
        ]:
            if skills_dir.is_dir():
                for d in skills_dir.iterdir():
                    if d.is_dir():
                        self._skill_names.add(d.name)
        self._strategies = HarnessMetricStrategies.snapshot_defaults()

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        return tool_name in self._SUBAGENT_TOOLS

    def detect_mcp_call(self, tool_name: str) -> bool:
        # Gemini uses single underscore: mcp_server_tool
        # Claude/Codex use double: mcp__server__tool
        return tool_name.startswith("mcp__") or (
            tool_name.startswith("mcp_") and tool_name not in self._BUILTIN_TOOLS
        )

    def detect_skill(self, tool_name: str, tool_input: dict) -> Optional[str]:
        # Gemini invokes skills via activate_skill tool with args.name
        if tool_name == "activate_skill":
            skill_name = tool_input.get("name", "")
            if skill_name:
                return skill_name
        # Non-builtin tool names that match installed skills
        if tool_name not in self._BUILTIN_TOOLS and tool_name in self._skill_names:
            return tool_name
        return None

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_gemini(since, parser=self, paths=self._paths)

    def metric_strategies(self) -> HarnessMetricStrategies:
        return self._strategies


def _load_gemini_project_hashes() -> dict[str, str]:
    projects_file = Path.home() / ".gemini" / "projects.json"
    if not projects_file.is_file():
        return {}
    try:
        data = json.loads(projects_file.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    projects = data.get("projects", {}) if isinstance(data, dict) else {}
    if not isinstance(projects, dict):
        return {}

    result: dict[str, str] = {}
    for path, display_name in projects.items():
        if not isinstance(path, str):
            continue
        project_hash = hashlib.sha256(path.encode("utf-8")).hexdigest()
        name = display_name if isinstance(display_name, str) and display_name.strip() else _basename_only(path)
        if name:
            result[project_hash] = name
    return result


def _resolve_gemini_skill_sources(
    skill_invocations: dict[str, int],
    gemini_project_dir: Path,
    paths,
) -> dict:
    """Determine skill source and scope for Gemini.

    Gemini scope mapping to common schema:
      user      → ~/.agents/skills/{name}    → scope: "user"
      workspace → {project}/.gemini/skills/  → scope: "project"
    """
    # Resolve actual project root from .project_root file
    project_root = None
    project_root_file = gemini_project_dir / ".project_root"
    if project_root_file.is_file():
        try:
            project_root = Path(project_root_file.read_text().strip())
        except OSError:
            pass

    result = {}
    for name, count in skill_invocations.items():
        scope = "user"
        source = "user-custom"
        # Check workspace/project level first
        if project_root:
            workspace_skill = project_root / ".gemini" / "skills" / name
            if workspace_skill.is_dir():
                scope = "project"
                source = "project-custom"
        result[name] = {"count": count, "source": source, "scope": scope}
    return result


def _parse_gemini(
    since: Optional[datetime] = None,
    parser: Optional[HarnessParser] = None,
    paths=None,
) -> list[SessionMeta]:
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
    paths = paths or get_gemini_history_paths()
    gemini_dir = paths.tmp_dir
    if not gemini_dir.is_dir():
        return []

    results: list[SessionMeta] = []
    project_hash_map = _load_gemini_project_hashes()

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

            project_hash = data.get("projectHash")
            project_dir_name = _basename_only(str(project_dir))
            project_name = project_hash_map.get(str(project_hash or ""))
            if not project_name and project_dir_name and len(project_dir_name) != 64:
                project_name = project_dir_name
            if not project_name:
                project_name = str(project_hash or project_dir_name or "unknown")

            model = "unknown"
            user_count = 0
            assistant_count = 0
            input_tokens = 0
            output_tokens = 0
            cache_read = 0
            tool_tokens = 0
            tool_call_count = 0
            tool_names: dict[str, int] = {}
            subagent_calls = 0
            _subagent_metas: list[SubagentMeta] = []
            tool_categories: dict[str, str] = {}
            mcp_calls = 0
            skill_invocations: dict[str, int] = {}
            has_thoughts = False
            mcp_servers: dict[str, dict] = {}
            time_tracker = TimeSpanTracker()

            for msg_idx, msg in enumerate(messages):
                msg_type = msg.get("type", "")
                msg_ts = msg.get("timestamp")
                msg_dt: Optional[datetime] = None
                if msg_ts:
                    try:
                        msg_dt = datetime.fromisoformat(msg_ts.replace("Z", "+00:00"))
                    except ValueError:
                        pass

                # Resolve pending tool calls from previous message using this message's timestamp
                # Gemini tool calls only have a start timestamp; the next message marks completion
                if msg_dt:
                    for pending_id in list(time_tracker._pending_tool_calls.keys()):
                        time_tracker.on_tool_end(pending_id, msg_dt)

                if msg_type == "user":
                    user_count += 1
                    if msg_dt:
                        time_tracker.on_user_turn(msg_dt)
                elif msg_type in ("gemini", "assistant", "model"):
                    assistant_count += 1
                    m = msg.get("model")
                    if m:
                        model = m
                    if msg_dt:
                        time_tracker.on_nonuser_event(msg_dt)

                tokens = msg.get("tokens", {}) or {}
                raw_in = _safe_int(tokens.get("input"))
                msg_out = _safe_int(tokens.get("output"))
                msg_cached = _safe_int(tokens.get("cached"))
                # Normalize: input_tokens = non-cached input (Claude convention)
                msg_in = max(0, raw_in - msg_cached)
                input_tokens += msg_in
                output_tokens += msg_out
                time_tracker.on_tokens(msg_in, msg_out)
                cache_read += msg_cached
                tool_tokens += _safe_int(tokens.get("tool"))

                # Extract tool calls from toolCalls array
                tool_calls_list = msg.get("toolCalls", [])
                if isinstance(tool_calls_list, list):
                    for tc in tool_calls_list:
                        if not isinstance(tc, dict):
                            continue
                        tool_name = tc.get("name", "unknown")
                        tool_call_count += 1
                        tool_names[tool_name] = tool_names.get(tool_name, 0) + 1

                        category = "tool"
                        if parser:
                            args = tc.get("args", {})
                            if not isinstance(args, dict):
                                args = {}
                            c = parser.classify_tool_call(tool_name, args)
                            if c["is_subagent"]:
                                category = "subagent"
                                subagent_calls += 1
                                _subagent_metas.append(SubagentMeta(
                                    ordinal=len(_subagent_metas),
                                    subagent_type=tool_name,
                                    description=tc.get("displayName", "") or tc.get("description", ""),
                                ))
                            if c["is_mcp"]:
                                category = "mcp"
                                mcp_calls += 1
                                _register_mcp_tool(mcp_servers, tool_name)
                            if c["skill_name"]:
                                category = "skill"
                                skill_invocations[c["skill_name"]] = skill_invocations.get(c["skill_name"], 0) + 1

                        tool_categories[tool_name] = category
                        # Start tool span — will be resolved by next message's timestamp
                        tc_ts = tc.get("timestamp")
                        if tc_ts:
                            try:
                                tc_dt = datetime.fromisoformat(tc_ts.replace("Z", "+00:00"))
                                call_id = tc.get("id", f"tc-{tool_call_count}")
                                time_tracker.on_tool_start(call_id, tool_name, category, tc_dt)
                            except ValueError:
                                pass

                # Detect thinking/reasoning from thoughts array
                thoughts = msg.get("thoughts", [])
                if thoughts:
                    has_thoughts = True

            time_spans, turn_exec_times = time_tracker.finalize()
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

            results.append(parser.session_from_snapshot({
                "id": _make_session_id(Harness.GEMINI, source_id),
                "source_session_id": source_id,
                "harness_version": None,
                "project_name": project_name,
                "git_repo_name": None,
                "git_branch": None,
                "model": model,
                "provider": "google",
                "message_count_user": user_count,
                "message_count_assistant": assistant_count,
                "message_count_total": total_count,
                "tool_call_count": tool_call_count,
                "subagent_calls": subagent_calls,
                "subagents": tuple(_subagent_metas),
                "mcp_calls": mcp_calls,
                "mcp_servers": mcp_servers,
                "tokens": TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read_tokens=cache_read,
                    total_tokens=input_tokens + output_tokens,
                ),
                "tool_calls": tuple(
                    ToolCallSummary(n, c, tool_categories.get(n, "tool")) for n, c in sorted(tool_names.items())
                ),
                "skills_used": _resolve_gemini_skill_sources(
                    skill_invocations, project_dir, paths
                ),
                "cost_usd": None,
                "started_at": started_at,
                "ended_at": ended_at,
                "duration_seconds": duration,
                "time_spans": time_spans,
                "total_exec_seconds": round(sum(turn_exec_times), 1) if turn_exec_times else None,
                "mean_turn_seconds": round(sum(turn_exec_times) / len(turn_exec_times), 1) if turn_exec_times else None,
                "median_turn_seconds": round(sorted(turn_exec_times)[len(turn_exec_times) // 2], 1) if turn_exec_times else None,
            }))

    return results
