import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { HarnessParser } from "../base-parser.js";
import { basenameOnly, makeSessionId, registerMcpTool, safeInt } from "../helpers.js";
import {
  getGeminiHistoryPaths,
  type GeminiHistoryPaths,
} from "../history-paths.js";
import { snapshotDefaults, type HarnessMetricStrategies } from "../metric-strategies.js";
import {
  createTokenUsage,
  Harness,
  type SessionMeta,
  type SubagentMeta,
  type ToolCallSummary,
} from "../models.js";
import { createSubagentMeta } from "../models.js";
import { TimeSpanTracker } from "../trackers.js";

export class GeminiParser extends HarnessParser {
  readonly harnessType = Harness.GEMINI;

  /** Gemini's built-in subagent tool names */
  private static readonly SUBAGENT_TOOLS = new Set([
    "generalist",
    "cli_help",
    "codebase_investigator",
  ]);

  /** Built-in tools that are NOT skills */
  private static readonly BUILTIN_TOOLS = new Set([
    "read_file",
    "write_file",
    "run_shell_command",
    "replace",
    "list_directory",
    "grep",
    "grep_search",
    "generalist",
    "cli_help",
    "codebase_investigator",
  ]);

  private readonly _paths: GeminiHistoryPaths;
  private readonly _skillNames: Set<string>;
  private readonly _strategies: HarnessMetricStrategies;

  constructor() {
    super();
    this._paths = getGeminiHistoryPaths();
    this._skillNames = new Set<string>();
    for (const skillsDir of [this._paths.skillsDir, this._paths.agentsSkillsDir]) {
      if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            this._skillNames.add(entry.name);
          }
        }
      }
    }
    this._strategies = snapshotDefaults();
  }

  detectSubagent(toolName: string, _toolInput: Record<string, unknown>): boolean {
    return GeminiParser.SUBAGENT_TOOLS.has(toolName);
  }

  detectMcpCall(toolName: string): boolean {
    return (
      toolName.startsWith("mcp__") ||
      (toolName.startsWith("mcp_") && !GeminiParser.BUILTIN_TOOLS.has(toolName))
    );
  }

  detectSkill(toolName: string, toolInput: Record<string, unknown>): string | null {
    // Gemini invokes skills via activate_skill tool with args.name
    if (toolName === "activate_skill") {
      const skillName = (toolInput.name as string) ?? "";
      if (skillName) return skillName;
    }
    // Non-builtin tool names that match installed skills
    if (!GeminiParser.BUILTIN_TOOLS.has(toolName) && this._skillNames.has(toolName)) {
      return toolName;
    }
    return null;
  }

  parse(since?: Date): SessionMeta[] {
    return parseGemini(since, this, this._paths);
  }

  metricStrategies(): HarnessMetricStrategies {
    return this._strategies;
  }
}

function loadGeminiProjectHashes(): Map<string, string> {
  const projectsFile = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
    ".gemini",
    "projects.json",
  );
  if (!fs.existsSync(projectsFile)) return new Map();

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(projectsFile, "utf-8"));
  } catch {
    return new Map();
  }

  const projects =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).projects : undefined;
  if (typeof projects !== "object" || projects === null) return new Map();

  const result = new Map<string, string>();
  for (const [filePath, displayName] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof filePath !== "string") continue;
    const projectHash = createHash("sha256").update(filePath).digest("hex");
    const name =
      typeof displayName === "string" && displayName.trim()
        ? displayName
        : basenameOnly(filePath);
    if (name) result.set(projectHash, name);
  }
  return result;
}

function resolveGeminiSkillSources(
  skillInvocations: Record<string, number>,
  geminiProjectDir: string,
  _paths: GeminiHistoryPaths,
): Record<string, Record<string, unknown>> {
  // Resolve actual project root from .project_root file
  let projectRoot: string | null = null;
  const projectRootFile = path.join(geminiProjectDir, ".project_root");
  if (fs.existsSync(projectRootFile)) {
    try {
      projectRoot = fs.readFileSync(projectRootFile, "utf-8").trim();
    } catch {
      // ignore
    }
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, count] of Object.entries(skillInvocations)) {
    let scope = "user";
    let source = "user-custom";
    // Check workspace/project level first
    if (projectRoot) {
      const workspaceSkill = path.join(projectRoot, ".gemini", "skills", name);
      if (fs.existsSync(workspaceSkill) && fs.statSync(workspaceSkill).isDirectory()) {
        scope = "project";
        source = "project-custom";
      }
    }
    result[name] = { count, source, scope };
  }
  return result;
}

function parseGemini(
  since: Date | undefined,
  parser: GeminiParser,
  paths: GeminiHistoryPaths,
): SessionMeta[] {
  const geminiDir = paths.tmpDir;
  if (!fs.existsSync(geminiDir) || !fs.statSync(geminiDir).isDirectory()) {
    return [];
  }

  const results: SessionMeta[] = [];
  const projectHashMap = loadGeminiProjectHashes();

  for (const projectEntry of fs.readdirSync(geminiDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDirPath = path.join(geminiDir, projectEntry.name);
    const chatsDir = path.join(projectDirPath, "chats");
    if (!fs.existsSync(chatsDir) || !fs.statSync(chatsDir).isDirectory()) continue;

    for (const sessionEntry of fs.readdirSync(chatsDir)) {
      if (!sessionEntry.startsWith("session-") || !sessionEntry.endsWith(".json")) continue;
      const sessionFile = path.join(chatsDir, sessionEntry);

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      } catch {
        continue;
      }

      const sourceId = (data.sessionId as string) ?? path.basename(sessionFile, ".json");
      const messages = data.messages as Record<string, unknown>[];
      if (!Array.isArray(messages) || messages.length === 0) continue;

      const startedAt = (data.startTime as string) ?? "";
      const endedAt = (data.lastUpdated as string) ?? null;

      // Apply --since filter
      if (since && startedAt) {
        try {
          const sessionStart = new Date(startedAt.replace("Z", "+00:00"));
          if (sessionStart.getTime() < since.getTime()) continue;
        } catch {
          // ignore
        }
      }

      const projectHash = data.projectHash as string | undefined;
      const projectDirName = basenameOnly(projectDirPath);
      let projectName = projectHashMap.get(String(projectHash ?? "")) ?? null;
      if (!projectName && projectDirName && projectDirName.length !== 64) {
        projectName = projectDirName;
      }
      if (!projectName) {
        projectName = String(projectHash ?? projectDirName ?? "unknown");
      }

      let model = "unknown";
      let userCount = 0;
      let assistantCount = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let toolTokens = 0;
      let toolCallCount = 0;
      const toolNames = new Map<string, number>();
      let subagentCalls = 0;
      const subagentMetas: Partial<SubagentMeta>[] = [];
      const toolCategories = new Map<string, string>();
      let mcpCalls = 0;
      const skillInvocations: Record<string, number> = {};
      let hasThoughts = false;
      const mcpServers: Record<string, Record<string, unknown>> = {};
      const timeTracker = new TimeSpanTracker();

      for (const msg of messages) {
        const msgType = (msg.type as string) ?? "";
        const msgTs = msg.timestamp as string | undefined;
        let msgDt: Date | null = null;
        if (msgTs) {
          try {
            const d = new Date(msgTs.replace("Z", "+00:00"));
            if (!Number.isNaN(d.getTime())) msgDt = d;
          } catch {
            // ignore
          }
        }

        // Resolve pending tool calls from previous message using this message's timestamp
        if (msgDt) {
          for (const pendingId of [...timeTracker.pendingCalls.keys()]) {
            timeTracker.onToolEnd(pendingId, msgDt);
          }
        }

        if (msgType === "user") {
          userCount++;
          if (msgDt) timeTracker.onUserTurn(msgDt);
        } else if (msgType === "gemini" || msgType === "assistant" || msgType === "model") {
          assistantCount++;
          const m = msg.model as string | undefined;
          if (m) model = m;
          if (msgDt) timeTracker.onNonuserEvent(msgDt);
        }

        const tokens = (msg.tokens ?? {}) as Record<string, unknown>;
        const rawIn = safeInt(tokens.input);
        const msgOut = safeInt(tokens.output);
        const msgCached = safeInt(tokens.cached);
        // Normalize: input_tokens = non-cached input (Claude convention)
        const msgIn = Math.max(0, rawIn - msgCached);
        inputTokens += msgIn;
        outputTokens += msgOut;
        timeTracker.onTokens(msgIn, msgOut);
        cacheRead += msgCached;
        toolTokens += safeInt(tokens.tool);

        // Extract tool calls from toolCalls array
        const toolCallsList = msg.toolCalls;
        if (Array.isArray(toolCallsList)) {
          for (const tc of toolCallsList) {
            if (typeof tc !== "object" || tc === null) continue;
            const tcObj = tc as Record<string, unknown>;
            const toolName = (tcObj.name as string) ?? "unknown";
            toolCallCount++;
            toolNames.set(toolName, (toolNames.get(toolName) ?? 0) + 1);

            let category = "tool";
            let args = (tcObj.args ?? {}) as Record<string, unknown>;
            if (typeof args !== "object" || args === null) args = {};
            const c = parser.classifyToolCall(toolName, args);
            if (c.is_subagent) {
              category = "subagent";
              subagentCalls++;
              subagentMetas.push({
                ordinal: subagentMetas.length,
                subagent_type: toolName,
                description:
                  ((tcObj.displayName as string) ?? "") || ((tcObj.description as string) ?? ""),
              });
            }
            if (c.is_mcp) {
              category = "mcp";
              mcpCalls++;
              registerMcpTool(mcpServers, toolName);
            }
            if (c.skill_name) {
              category = "skill";
              skillInvocations[c.skill_name] =
                (skillInvocations[c.skill_name] ?? 0) + 1;
            }

            toolCategories.set(toolName, category);

            // Start tool span — will be resolved by next message's timestamp
            const tcTs = tcObj.timestamp as string | undefined;
            if (tcTs) {
              try {
                const tcDt = new Date(tcTs.replace("Z", "+00:00"));
                if (!Number.isNaN(tcDt.getTime())) {
                  const callId = (tcObj.id as string) ?? `tc-${toolCallCount}`;
                  timeTracker.onToolStart(callId, toolName, category, tcDt);
                }
              } catch {
                // ignore
              }
            }
          }
        }

        // Detect thinking/reasoning from thoughts array
        const thoughts = msg.thoughts;
        if (Array.isArray(thoughts) && thoughts.length > 0) {
          hasThoughts = true;
        }
      }

      const { timeSpans, turnExecTimes } = timeTracker.finalize();
      const totalCount = messages.length;

      // Duration from timestamps
      let duration: number | null = null;
      if (startedAt && endedAt) {
        try {
          const s = new Date(startedAt.replace("Z", "+00:00"));
          const e = new Date(endedAt.replace("Z", "+00:00"));
          duration = Math.max(0, Math.floor((e.getTime() - s.getTime()) / 1000));
        } catch {
          // ignore
        }
      }

      const toolCallSummaries: ToolCallSummary[] = [...toolNames.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, c]) => ({
          tool_name: n,
          invocation_count: c,
          category: toolCategories.get(n) ?? "tool",
        }));

      results.push(
        parser.sessionFromSnapshot({
          id: makeSessionId(Harness.GEMINI, sourceId),
          source_session_id: sourceId,
          harness_version: null,
          project_name: projectName,
          git_repo_name: null,
          git_branch: null,
          model,
          provider: "google",
          message_count_user: userCount,
          message_count_assistant: assistantCount,
          message_count_total: totalCount,
          tool_call_count: toolCallCount,
          subagent_calls: subagentCalls,
          subagents: subagentMetas.map((m) => createSubagentMeta(m)),
          mcp_calls: mcpCalls,
          mcp_servers: mcpServers,
          tokens: createTokenUsage({
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_tokens: cacheRead,
            total_tokens: inputTokens + outputTokens,
          }),
          tool_calls: toolCallSummaries,
          skills_used: resolveGeminiSkillSources(skillInvocations, projectDirPath, paths),
          cost_usd: null,
          started_at: startedAt,
          ended_at: endedAt,
          duration_seconds: duration,
          time_spans: timeSpans,
          total_exec_seconds:
            turnExecTimes.length > 0
              ? Math.round(turnExecTimes.reduce((a, b) => a + b, 0) * 10) / 10
              : null,
          mean_turn_seconds:
            turnExecTimes.length > 0
              ? Math.round(
                  (turnExecTimes.reduce((a, b) => a + b, 0) / turnExecTimes.length) * 10,
                ) / 10
              : null,
          median_turn_seconds:
            turnExecTimes.length > 0
              ? Math.round(
                  [...turnExecTimes].sort((a, b) => a - b)[
                    Math.floor(turnExecTimes.length / 2)
                  ] * 10,
                ) / 10
              : null,
        }),
      );
    }
  }

  return results;
}
