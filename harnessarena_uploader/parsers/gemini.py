from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..base_parser import HarnessParser
from ..helpers import _basename_only, _make_session_id, _safe_int
from ..models import Harness, SessionMeta, TokenUsage, ToolCallSummary


class GeminiParser(HarnessParser):
    """Gemini CLI session parser.

    Gemini stores tool calls in msg.toolCalls array with {name, args, result}.
    Subagents appear as tool calls with name like "generalist", "cli_help", etc.
    Thoughts/reasoning appear in msg.thoughts array and tokens.thoughts count.
    """

    harness_type = Harness.GEMINI

    # Gemini's built-in subagent tool names
    _SUBAGENT_TOOLS = {"generalist", "cli_help", "codebase_investigator"}

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        return tool_name in self._SUBAGENT_TOOLS

    def detect_mcp_call(self, tool_name: str) -> bool:
        return tool_name.startswith("mcp__")

    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        return _parse_gemini(since, parser=self)


def _parse_gemini(since: Optional[datetime] = None, parser: Optional[HarnessParser] = None) -> list[SessionMeta]:
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
    gemini_dir = Path.home() / ".gemini" / "tmp"
    if not gemini_dir.is_dir():
        return []

    results: list[SessionMeta] = []

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

            # Project hash (already non-reversible, privacy-safe)
            project_hash = data.get("projectHash")
            # Also check the directory name as fallback
            project_name = project_hash or _basename_only(str(project_dir))

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
            mcp_calls = 0
            has_thoughts = False

            for msg in messages:
                msg_type = msg.get("type", "")
                if msg_type == "user":
                    user_count += 1
                elif msg_type in ("gemini", "assistant", "model"):
                    assistant_count += 1
                    m = msg.get("model")
                    if m:
                        model = m

                tokens = msg.get("tokens", {}) or {}
                input_tokens += _safe_int(tokens.get("input"))
                output_tokens += _safe_int(tokens.get("output"))
                cache_read += _safe_int(tokens.get("cached"))
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
                        if parser:
                            args = tc.get("args", {})
                            if not isinstance(args, dict):
                                args = {}
                            c = parser.classify_tool_call(tool_name, args)
                            if c["is_subagent"]:
                                subagent_calls += 1
                            if c["is_mcp"]:
                                mcp_calls += 1

                # Detect thinking/reasoning from thoughts array
                thoughts = msg.get("thoughts", [])
                if thoughts:
                    has_thoughts = True

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

            results.append(SessionMeta(
                id=_make_session_id(Harness.GEMINI, source_id),
                source_session_id=source_id,
                harness=Harness.GEMINI,
                harness_version=None,
                project_name=project_name,
                git_repo_name=None,  # Gemini uses project hash, not repo name
                git_branch=None,
                model=model,
                provider="google",
                message_count_user=user_count,
                message_count_assistant=assistant_count,
                message_count_total=total_count,
                tool_call_count=tool_call_count,
                subagent_calls=subagent_calls,
                mcp_calls=mcp_calls,
                tokens=TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read_tokens=cache_read,
                    total_tokens=input_tokens + output_tokens,
                ),
                tool_calls=tuple(
                    ToolCallSummary(n, c) for n, c in sorted(tool_names.items())
                ),
                cost_usd=None,
                started_at=started_at,
                ended_at=ended_at,
                duration_seconds=duration,
            ))

    return results
