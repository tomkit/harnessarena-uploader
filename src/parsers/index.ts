import type { HarnessParser } from "../base-parser.js";
import { Harness } from "../models.js";
import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { CursorAgentParser } from "./cursor-agent.js";
import { GeminiParser } from "./gemini.js";
import { OpenCodeParser } from "./opencode.js";

export const PARSERS: Record<string, HarnessParser> = {
  [Harness.CLAUDE]: new ClaudeParser(),
  [Harness.GEMINI]: new GeminiParser(),
  [Harness.CODEX]: new CodexParser(),
  [Harness.AGENT]: new CursorAgentParser(),
  [Harness.OPENCODE]: new OpenCodeParser(),
};

export {
  ClaudeParser,
  CodexParser,
  CursorAgentParser,
  GeminiParser,
  OpenCodeParser,
};
