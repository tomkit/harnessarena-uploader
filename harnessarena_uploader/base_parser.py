from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Optional

from .metric_strategies import HarnessMetricStrategies
from .models import Harness, SessionMeta


class HarnessParser(ABC):
    """Base class for harness session parsers.

    Subclasses MUST set `harness_type` and implement `parse()`.
    Concept detectors have default no-op implementations — override only
    those that apply to your harness.
    """

    harness_type: Harness

    @abstractmethod
    def parse(self, since: Optional[datetime] = None) -> list[SessionMeta]:
        """Discover and parse all sessions for this harness."""
        ...

    @abstractmethod
    def metric_strategies(self) -> HarnessMetricStrategies:
        """Return the first-class metric parsing strategies for this harness."""
        ...

    # --- Concept detectors (override per harness) ---------------------------

    def detect_subagent(self, tool_name: str, tool_input: dict) -> bool:
        """Return True if this tool call spawns a subagent."""
        return False

    def detect_background_agent(self, tool_name: str, tool_input: dict) -> bool:
        """Return True if this tool call spawns a background agent."""
        return False

    def detect_mcp_call(self, tool_name: str) -> bool:
        """Return True if this tool call targets an MCP server."""
        return tool_name.startswith("mcp__")

    def detect_skill(self, tool_name: str, tool_input: dict) -> Optional[str]:
        """Return skill name if this is a skill invocation, else None."""
        return None

    def detect_plan_mode_enter(self, tool_name: str) -> bool:
        """Return True if this tool call enters plan/think mode."""
        return False

    def detect_plan_mode_exit(self, tool_name: str) -> bool:
        """Return True if this tool call exits plan/think mode."""
        return False

    # --- Unified dispatch ---------------------------------------------------

    def classify_tool_call(self, tool_name: str, tool_input: dict) -> dict:
        """Classify a single tool call against all concept detectors."""
        return {
            "is_subagent": self.detect_subagent(tool_name, tool_input),
            "is_background_agent": self.detect_background_agent(tool_name, tool_input),
            "is_mcp": self.detect_mcp_call(tool_name),
            "skill_name": self.detect_skill(tool_name, tool_input),
            "is_plan_enter": self.detect_plan_mode_enter(tool_name),
            "is_plan_exit": self.detect_plan_mode_exit(tool_name),
        }

    # --- Shared helpers -----------------------------------------------------

    @staticmethod
    def compute_intervention_rate(
        user_count: int, tool_call_count: int
    ) -> Optional[float]:
        if tool_call_count > 0:
            return round(user_count / tool_call_count, 2)
        return None

    def session_from_snapshot(self, snapshot: dict[str, Any]) -> SessionMeta:
        """Build a SessionMeta from a harness-specific snapshot via metric strategies."""
        metrics = self.metric_strategies()
        prompt_metric = metrics.prompts.parse(snapshot)
        subagent_metric = metrics.subagents.parse(snapshot)
        mcp_metric = metrics.mcp.parse(snapshot)
        skill_metric = metrics.skills.parse(snapshot)
        tool_metric = metrics.tools.parse(snapshot)
        token_metric = metrics.tokens.parse(snapshot)
        plan_metric = metrics.plan.parse(snapshot)
        daily_metric = metrics.daily.parse(snapshot)
        cost_metric = metrics.cost.parse(snapshot)

        return SessionMeta(
            id=snapshot["id"],
            source_session_id=snapshot["source_session_id"],
            harness=self.harness_type,
            harness_version=snapshot.get("harness_version"),
            project_name=snapshot.get("project_name"),
            git_repo_name=snapshot.get("git_repo_name"),
            git_branch=snapshot.get("git_branch"),
            model=snapshot["model"],
            provider=snapshot["provider"],
            message_count_user=prompt_metric.message_count_user,
            message_count_assistant=prompt_metric.message_count_assistant,
            message_count_total=prompt_metric.message_count_total,
            tool_call_count=tool_metric.tool_call_count,
            tokens=token_metric,
            subagent_calls=subagent_metric.subagent_calls,
            background_agents=subagent_metric.background_agents,
            mcp_calls=mcp_metric.mcp_calls,
            plan_mode_entries=plan_metric.plan_mode_entries,
            plan_mode_exits=plan_metric.plan_mode_exits,
            tool_calls=tool_metric.tool_calls,
            skills_used=skill_metric.skills_used,
            mcp_servers={
                server.server_name: {
                    "count": server.invocation_count,
                    "uri": server.uri,
                    "primitives": [
                        {
                            "name": primitive.name,
                            "type": primitive.primitive_type,
                            "count": primitive.invocation_count,
                        }
                        for primitive in server.primitives
                    ],
                }
                for server in mcp_metric.servers
            },
            daily=daily_metric.daily,
            cost_usd=cost_metric.cost_usd,
            intervention_rate=prompt_metric.intervention_rate,
            data_completeness=snapshot.get("data_completeness", "full"),
            is_pruned=bool(snapshot.get("is_pruned", False)),
            started_at=snapshot["started_at"],
            ended_at=snapshot.get("ended_at"),
            duration_seconds=snapshot.get("duration_seconds"),
            total_exec_seconds=snapshot.get("total_exec_seconds"),
            mean_turn_seconds=snapshot.get("mean_turn_seconds"),
            median_turn_seconds=snapshot.get("median_turn_seconds"),
            time_spans=snapshot.get("time_spans", []),
            parent_session_id=snapshot.get("parent_session_id"),
            agent_name=snapshot.get("agent_name"),
            subagents=tuple(snapshot.get("subagents", ())),
        )
