from __future__ import annotations

from ..base_parser import HarnessParser
from ..models import Harness
from .claude import ClaudeParser
from .codex import CodexParser
from .cursor_agent import CursorAgentParser
from .gemini import GeminiParser
from .opencode import OpenCodeParser

PARSERS: dict[Harness, HarnessParser] = {
    Harness.CLAUDE: ClaudeParser(),
    Harness.GEMINI: GeminiParser(),
    Harness.CODEX: CodexParser(),
    Harness.AGENT: CursorAgentParser(),
    Harness.OPENCODE: OpenCodeParser(),
}

__all__ = [
    "PARSERS",
    "ClaudeParser",
    "GeminiParser",
    "CodexParser",
    "CursorAgentParser",
    "OpenCodeParser",
]
