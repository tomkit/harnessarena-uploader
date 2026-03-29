from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

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
