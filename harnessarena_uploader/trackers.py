"""Reusable tracker classes for harness session parsing.

Extracts the duplicated state machines from claude.py and codex.py into
composable, zero-dependency tracker objects. Each tracker owns one concern
(time spans, plan mode, daily breakdown, tool classification, subagents).
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Optional

from .helpers import _register_mcp_tool
from .models import SubagentMeta


class TimeSpanTracker:
    """Track harness_exec and user_idle time spans across turns.

    State machine: on_user_turn() emits the previous turn's exec + idle spans,
    on_nonuser_event() updates the latest non-user timestamp, and on_tool_start/end
    track individual tool call durations within a turn.
    """

    def __init__(self) -> None:
        self._last_user_ts: Optional[datetime] = None
        self._last_nonuser_ts: Optional[datetime] = None
        self._pending_tool_calls: dict[str, dict] = {}
        self._current_turn_tool_spans: list[dict] = []
        self._current_turn_input_tokens: int = 0
        self._current_turn_output_tokens: int = 0
        self._time_spans: list[dict] = []
        self._turn_exec_times: list[float] = []

    def on_user_turn(self, dt: datetime) -> None:
        """Record a real user turn boundary.

        Emits harness_exec + user_idle spans for the previous turn if applicable.
        Resets per-turn state.
        """
        if self._last_user_ts and self._last_nonuser_ts:
            exec_dur = (self._last_nonuser_ts - self._last_user_ts).total_seconds()
            idle_dur = (dt - self._last_nonuser_ts).total_seconds()
            if exec_dur > 0:
                span: dict = {
                    "type": "harness_exec",
                    "start": self._last_user_ts.isoformat(),
                    "end": self._last_nonuser_ts.isoformat(),
                    "seconds": round(exec_dur, 1),
                }
                if self._current_turn_tool_spans:
                    span["tool_spans"] = self._current_turn_tool_spans[:]
                if self._current_turn_input_tokens > 0 or self._current_turn_output_tokens > 0:
                    span["input_tokens"] = self._current_turn_input_tokens
                    span["output_tokens"] = self._current_turn_output_tokens
                    span["tokens"] = self._current_turn_input_tokens + self._current_turn_output_tokens
                self._time_spans.append(span)
                if exec_dur < 1800:
                    self._turn_exec_times.append(exec_dur)
            if idle_dur > 0:
                self._time_spans.append({
                    "type": "user_idle",
                    "start": self._last_nonuser_ts.isoformat(),
                    "end": dt.isoformat(),
                    "seconds": round(idle_dur, 1),
                })
        self._last_user_ts = dt
        self._last_nonuser_ts = None
        self._current_turn_tool_spans = []
        self._current_turn_input_tokens = 0
        self._current_turn_output_tokens = 0
        self._pending_tool_calls = {}

    def on_nonuser_event(self, dt: datetime) -> None:
        """Record the timestamp of a non-user event (assistant, system, tool output)."""
        self._last_nonuser_ts = dt

    def on_tokens(self, input_tokens: int, output_tokens: int = 0) -> None:
        """Accumulate tokens for the current turn."""
        self._current_turn_input_tokens += input_tokens
        self._current_turn_output_tokens += output_tokens

    def on_tool_start(self, call_id: str, name: str, category: str, dt: datetime) -> None:
        """Record a tool call start for span timing."""
        self._pending_tool_calls[call_id] = {
            "name": name,
            "category": category,
            "start_dt": dt,
        }

    def on_tool_end(self, call_id: str, dt: datetime) -> Optional[dict]:
        """Record a tool call end. Returns the tool_span dict if matched, else None."""
        if call_id not in self._pending_tool_calls:
            return None
        pending = self._pending_tool_calls.pop(call_id)
        dur = (dt - pending["start_dt"]).total_seconds()
        if dur >= 0:
            tool_span_entry = {
                "name": pending["name"],
                "category": pending["category"],
                "start": pending["start_dt"].isoformat(),
                "end": dt.isoformat(),
                "seconds": round(dur, 3),
            }
            self._current_turn_tool_spans.append(tool_span_entry)
            return tool_span_entry
        return None

    def finalize(self) -> tuple[list[dict], list[float]]:
        """Capture the last turn and return (time_spans, turn_exec_times)."""
        if self._last_user_ts and self._last_nonuser_ts:
            exec_dur = (self._last_nonuser_ts - self._last_user_ts).total_seconds()
            if exec_dur > 0:
                span: dict = {
                    "type": "harness_exec",
                    "start": self._last_user_ts.isoformat(),
                    "end": self._last_nonuser_ts.isoformat(),
                    "seconds": round(exec_dur, 1),
                }
                if self._current_turn_tool_spans:
                    span["tool_spans"] = self._current_turn_tool_spans[:]
                if self._current_turn_input_tokens > 0 or self._current_turn_output_tokens > 0:
                    span["input_tokens"] = self._current_turn_input_tokens
                    span["output_tokens"] = self._current_turn_output_tokens
                    span["tokens"] = self._current_turn_input_tokens + self._current_turn_output_tokens
                self._time_spans.append(span)
                if exec_dur < 1800:
                    self._turn_exec_times.append(exec_dur)
        return self._time_spans, self._turn_exec_times


class PlanModeTracker:
    """Track plan mode enter/exit events and plan mode time spans."""

    def __init__(self) -> None:
        self._entries: int = 0
        self._exits: int = 0
        self._start: Optional[datetime] = None
        self._tool_spans: list[dict] = []
        self._spans: list[dict] = []

    def on_enter(self, dt: datetime) -> None:
        """Record plan mode entry."""
        self._entries += 1
        self._start = dt
        self._tool_spans = []

    def on_exit(self, dt: datetime) -> None:
        """Record plan mode exit. Emits a plan_mode span if timing is available."""
        self._exits += 1
        if self._start:
            dur = (dt - self._start).total_seconds()
            if dur > 0:
                ps: dict = {
                    "type": "plan_mode",
                    "start": self._start.isoformat(),
                    "end": dt.isoformat(),
                    "seconds": round(dur, 1),
                }
                if self._tool_spans:
                    ps["tool_spans"] = self._tool_spans[:]
                self._spans.append(ps)
            self._start = None
            self._tool_spans = []

    def on_tool_span(self, span: dict) -> None:
        """Record a tool span that occurred during plan mode."""
        if self._start is not None:
            self._tool_spans.append(span)

    def replace_session_level(self, time_spans: list[dict], plan_entries: int) -> None:
        """If session-level plan mode and no explicit plan spans, replace harness_exec with plan_mode.

        Modifies time_spans in place.
        """
        is_plan = (self._entries > 0 or plan_entries > 0)
        if not is_plan or not time_spans:
            return
        if any(s.get("type") == "plan_mode" for s in time_spans):
            return
        all_starts = [s["start"] for s in time_spans if s.get("type") == "harness_exec"]
        all_ends = [s["end"] for s in time_spans if s.get("type") == "harness_exec"]
        if not all_starts or not all_ends:
            return
        ps_start = min(all_starts)
        ps_end = max(all_ends)
        total_exec = sum(s["seconds"] for s in time_spans if s.get("type") == "harness_exec")
        plan_tool_spans = []
        for s in time_spans:
            if s.get("type") == "harness_exec" and "tool_spans" in s:
                plan_tool_spans.extend(s["tool_spans"])
        time_spans[:] = [s for s in time_spans if s.get("type") != "harness_exec"]
        plan_span_entry: dict = {
            "type": "plan_mode",
            "start": ps_start,
            "end": ps_end,
            "seconds": round(total_exec, 1),
        }
        if plan_tool_spans:
            plan_span_entry["tool_spans"] = plan_tool_spans
        time_spans.append(plan_span_entry)

    @property
    def entries(self) -> int:
        return self._entries

    @property
    def exits(self) -> int:
        return self._exits

    @property
    def spans(self) -> list[dict]:
        return self._spans

    @property
    def is_active(self) -> bool:
        return self._start is not None


class DailyTracker:
    """Accumulate per-date metric counters."""

    def __init__(self) -> None:
        self._data: dict[str, dict] = {}

    def add(self, date_str: str, **kwargs: int) -> None:
        if date_str not in self._data:
            self._data[date_str] = {
                "date": date_str, "tokens_in": 0, "tokens_out": 0, "tokens_total": 0,
                "prompts": 0, "sessions": 0, "subagent_calls": 0,
                "background_agents": 0, "tool_calls": 0, "mcp_calls": 0,
            }
        for k, v in kwargs.items():
            self._data[date_str][k] = self._data[date_str].get(k, 0) + v

    def mark_session_start(self, date_str: str) -> None:
        """Mark that a session started on this date (sets sessions=1)."""
        if date_str in self._data:
            self._data[date_str]["sessions"] = 1

    def finalize(self) -> list[dict]:
        return sorted(self._data.values(), key=lambda d: d["date"])


class ToolClassifier:
    """Classify tool calls and accumulate counters.

    Delegates to the parser's classify_tool_call method for detection,
    then updates all relevant counters and trackers as side effects.
    """

    def __init__(self) -> None:
        self._subagent_calls: int = 0
        self._background_agents: int = 0
        self._mcp_calls: int = 0
        self._tool_names: Counter = Counter()
        self._tool_categories: dict[str, str] = {}  # tool_name -> category
        self._skill_invocations: Counter = Counter()
        self._mcp_servers: dict[str, dict] = {}

    def record(
        self,
        tool_name: str,
        tool_input: dict,
        parser,
        timestamp_dt: Optional[datetime] = None,
        plan_tracker: Optional[PlanModeTracker] = None,
        time_tracker: Optional[TimeSpanTracker] = None,
        subagent_collector: Optional[SubagentCollector] = None,
        daily_tracker: Optional[DailyTracker] = None,
        date: Optional[str] = None,
    ) -> str:
        """Classify a tool call and update all counters/trackers.

        Returns the category: "tool", "subagent", "mcp", or "skill".
        """
        self._tool_names[tool_name] += 1
        category: str = "tool"

        if parser is None:
            # Fallback inline detection (no parser)
            if tool_name == "Agent":
                category = "subagent"
                self._subagent_calls += 1
                if daily_tracker and date:
                    daily_tracker.add(date, subagent_calls=1)
                if isinstance(tool_input, dict) and tool_input.get("run_in_background"):
                    self._background_agents += 1
                    if daily_tracker and date:
                        daily_tracker.add(date, background_agents=1)
            elif tool_name == "Skill":
                category = "skill"
                skill = tool_input.get("skill", "unknown") if isinstance(tool_input, dict) else "unknown"
                self._skill_invocations[skill] += 1
            elif tool_name.startswith("mcp__"):
                category = "mcp"
                self._mcp_calls += 1
                if daily_tracker and date:
                    daily_tracker.add(date, mcp_calls=1)
            return category

        c = parser.classify_tool_call(tool_name, tool_input)

        if c["is_subagent"]:
            category = "subagent"
            self._subagent_calls += 1
            if daily_tracker and date:
                daily_tracker.add(date, subagent_calls=1)
            is_bg = c["is_background_agent"]
            if is_bg:
                self._background_agents += 1
                if daily_tracker and date:
                    daily_tracker.add(date, background_agents=1)
            if subagent_collector:
                subagent_collector.record_spawn(
                    mode="background" if is_bg else "foreground",
                    subagent_type=tool_input.get("subagent_type", "") if isinstance(tool_input, dict) else "",
                    description=tool_input.get("description", "") if isinstance(tool_input, dict) else "",
                )

        if c["skill_name"]:
            category = "skill"
            self._skill_invocations[c["skill_name"]] += 1

        if c["is_mcp"]:
            category = "mcp"
            self._mcp_calls += 1
            _register_mcp_tool(self._mcp_servers, tool_name)
            if daily_tracker and date:
                daily_tracker.add(date, mcp_calls=1)

        if c["is_plan_enter"] and plan_tracker:
            if timestamp_dt:
                plan_tracker.on_enter(timestamp_dt)
            else:
                plan_tracker._entries += 1

        if c["is_plan_exit"] and plan_tracker:
            if timestamp_dt:
                plan_tracker.on_exit(timestamp_dt)
            else:
                plan_tracker._exits += 1

        self._tool_categories[tool_name] = category
        return category

    @property
    def tool_categories(self) -> dict[str, str]:
        return self._tool_categories

    @property
    def subagent_calls(self) -> int:
        return self._subagent_calls

    @property
    def background_agents(self) -> int:
        return self._background_agents

    @property
    def mcp_calls(self) -> int:
        return self._mcp_calls

    @property
    def tool_names(self) -> Counter:
        return self._tool_names

    @property
    def skill_invocations(self) -> Counter:
        return self._skill_invocations

    @property
    def mcp_servers(self) -> dict:
        return self._mcp_servers


class SubagentCollector:
    """Collect subagent metadata from tool_use blocks and directory listings."""

    def __init__(self) -> None:
        self._metas: list[dict] = []

    def record_spawn(self, mode: str = "foreground", subagent_type: str = "", description: str = "") -> None:
        self._metas.append({
            "ordinal": len(self._metas),
            "mode": mode,
            "subagent_type": subagent_type,
            "description": description,
        })

    def enrich(self, idx: int, total_tokens: int = 0, total_tool_calls: int = 0) -> None:
        """Enrich the subagent at index idx with per-file metrics."""
        if idx < len(self._metas):
            self._metas[idx]["total_tokens"] = total_tokens
            self._metas[idx]["total_tool_calls"] = total_tool_calls

    def ensure_count(self, min_count: int) -> None:
        """Fill placeholders if directory count > tool_use count."""
        while len(self._metas) < min_count:
            self._metas.append({
                "ordinal": len(self._metas),
                "mode": "foreground",
                "subagent_type": "",
                "description": "",
            })

    def finalize(self) -> tuple:
        """Return tuple of SubagentMeta from collected data."""
        return tuple(SubagentMeta(**m) for m in self._metas)

    @property
    def raw_metas(self) -> list[dict]:
        """Access the raw metas list (for Codex spawn_agent enrichment)."""
        return self._metas

    def __len__(self) -> int:
        return len(self._metas)
