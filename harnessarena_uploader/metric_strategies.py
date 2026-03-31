from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from .models import MCPPrimitiveSummary, MCPServerSummary, TokenUsage, ToolCallSummary


@dataclass(frozen=True)
class SessionCountMetric:
    total_sessions: int = 1


@dataclass(frozen=True)
class PromptMetric:
    message_count_user: int = 0
    message_count_assistant: int = 0
    message_count_total: int = 0
    intervention_rate: Optional[float] = None


@dataclass(frozen=True)
class SubagentMetric:
    subagent_calls: int = 0
    background_agents: int = 0


@dataclass(frozen=True)
class MCPMetric:
    mcp_calls: int = 0
    servers: tuple[MCPServerSummary, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SkillMetric:
    skills_used: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ToolMetric:
    tool_call_count: int = 0
    tool_calls: tuple[ToolCallSummary, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class PlanMetric:
    plan_mode_entries: int = 0
    plan_mode_exits: int = 0


@dataclass(frozen=True)
class DailyMetric:
    daily: list = field(default_factory=list)


@dataclass(frozen=True)
class CostMetric:
    cost_usd: Optional[float] = None


class SessionsMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> SessionCountMetric:
        ...


class PromptsMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> PromptMetric:
        ...


class SubagentsMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> SubagentMetric:
        ...


class MCPMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> MCPMetric:
        ...


class SkillsMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> SkillMetric:
        ...


class ToolMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> ToolMetric:
        ...


class TokenMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> TokenUsage:
        ...


class PlanMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> PlanMetric:
        ...


class DailyMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> DailyMetric:
        ...


class CostMetricStrategy(ABC):
    @abstractmethod
    def parse(self, payload: Any) -> CostMetric:
        ...


@dataclass(frozen=True)
class HarnessMetricStrategies:
    sessions: SessionsMetricStrategy
    prompts: PromptsMetricStrategy
    subagents: SubagentsMetricStrategy
    mcp: MCPMetricStrategy
    skills: SkillsMetricStrategy
    tools: ToolMetricStrategy
    tokens: TokenMetricStrategy
    plan: PlanMetricStrategy
    daily: DailyMetricStrategy
    cost: CostMetricStrategy

    @classmethod
    def snapshot_defaults(cls) -> "HarnessMetricStrategies":
        """Standard strategy set used by parsers that build sessions from snapshots."""
        return cls(
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


class ConstantSessionsMetricStrategy(SessionsMetricStrategy):
    def __init__(self, total_sessions: int = 1) -> None:
        self._metric = SessionCountMetric(total_sessions=total_sessions)

    def parse(self, payload: Any) -> SessionCountMetric:
        return self._metric


class NoPromptMetricStrategy(PromptsMetricStrategy):
    def parse(self, payload: Any) -> PromptMetric:
        return PromptMetric()


class NoSubagentMetricStrategy(SubagentsMetricStrategy):
    def parse(self, payload: Any) -> SubagentMetric:
        return SubagentMetric()


class NoMCPMetricStrategy(MCPMetricStrategy):
    def parse(self, payload: Any) -> MCPMetric:
        return MCPMetric()


class NoSkillMetricStrategy(SkillsMetricStrategy):
    def parse(self, payload: Any) -> SkillMetric:
        return SkillMetric()


class NoToolMetricStrategy(ToolMetricStrategy):
    def parse(self, payload: Any) -> ToolMetric:
        return ToolMetric()


class NoTokenMetricStrategy(TokenMetricStrategy):
    def parse(self, payload: Any) -> TokenUsage:
        return TokenUsage()


class NoPlanMetricStrategy(PlanMetricStrategy):
    def parse(self, payload: Any) -> PlanMetric:
        return PlanMetric()


class NoDailyMetricStrategy(DailyMetricStrategy):
    def parse(self, payload: Any) -> DailyMetric:
        return DailyMetric()


class NoCostMetricStrategy(CostMetricStrategy):
    def parse(self, payload: Any) -> CostMetric:
        return CostMetric()


class SnapshotPromptMetricStrategy(PromptsMetricStrategy):
    def parse(self, payload: Any) -> PromptMetric:
        user_count = int(payload.get("message_count_user", 0))
        tool_call_count = int(payload.get("tool_call_count", 0))
        intervention = round(user_count / tool_call_count, 2) if tool_call_count > 0 else None
        return PromptMetric(
            message_count_user=user_count,
            message_count_assistant=int(payload.get("message_count_assistant", 0)),
            message_count_total=int(payload.get("message_count_total", 0)),
            intervention_rate=intervention,
        )


class SnapshotSubagentMetricStrategy(SubagentsMetricStrategy):
    def parse(self, payload: Any) -> SubagentMetric:
        return SubagentMetric(
            subagent_calls=int(payload.get("subagent_calls", 0)),
            background_agents=int(payload.get("background_agents", 0)),
        )


class SnapshotMCPMetricStrategy(MCPMetricStrategy):
    def parse(self, payload: Any) -> MCPMetric:
        servers = payload.get("mcp_servers", {})
        return MCPMetric(
            mcp_calls=int(payload.get("mcp_calls", 0)),
            servers=mcp_server_summaries_from_dict(servers if isinstance(servers, dict) else {}),
        )


class SnapshotSkillMetricStrategy(SkillsMetricStrategy):
    def parse(self, payload: Any) -> SkillMetric:
        skills = payload.get("skills_used", {})
        return SkillMetric(skills_used=skills if isinstance(skills, dict) else {})


class SnapshotToolMetricStrategy(ToolMetricStrategy):
    def parse(self, payload: Any) -> ToolMetric:
        tool_calls = payload.get("tool_calls", ())
        if isinstance(tool_calls, list):
            tool_calls = tuple(tool_calls)
        return ToolMetric(
            tool_call_count=int(payload.get("tool_call_count", 0)),
            tool_calls=tool_calls if isinstance(tool_calls, tuple) else tuple(),
        )


class SnapshotTokenMetricStrategy(TokenMetricStrategy):
    def parse(self, payload: Any) -> TokenUsage:
        tokens = payload.get("tokens")
        if isinstance(tokens, TokenUsage):
            return tokens
        return TokenUsage()


class SnapshotPlanMetricStrategy(PlanMetricStrategy):
    def parse(self, payload: Any) -> PlanMetric:
        return PlanMetric(
            plan_mode_entries=int(payload.get("plan_mode_entries", 0)),
            plan_mode_exits=int(payload.get("plan_mode_exits", 0)),
        )


class SnapshotDailyMetricStrategy(DailyMetricStrategy):
    def parse(self, payload: Any) -> DailyMetric:
        daily = payload.get("daily", [])
        return DailyMetric(daily=daily if isinstance(daily, list) else [])


class SnapshotCostMetricStrategy(CostMetricStrategy):
    def parse(self, payload: Any) -> CostMetric:
        cost = payload.get("cost_usd")
        return CostMetric(cost_usd=cost if isinstance(cost, (int, float)) and cost >= 0 else None)


def mcp_server_summaries_from_dict(servers: dict[str, dict]) -> tuple[MCPServerSummary, ...]:
    summaries: list[MCPServerSummary] = []
    for server_name, info in sorted(servers.items()):
        primitives = tuple(
            MCPPrimitiveSummary(
                name=primitive_name,
                primitive_type=primitive_info.get("primitive_type", "tool"),
                invocation_count=int(primitive_info.get("invocation_count", 1)),
            )
            for primitive_name, primitive_info in sorted(info.get("primitives", {}).items())
        )
        summaries.append(
            MCPServerSummary(
                server_name=server_name,
                invocation_count=int(info.get("invocation_count", 1)),
                uri=info.get("uri"),
                primitives=primitives,
            )
        )
    return tuple(summaries)
