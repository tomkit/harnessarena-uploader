import * as fs from "node:fs";

import Database from "better-sqlite3";

import { HarnessParser } from "../base-parser.js";
import { basenameOnly, makeSessionId, parseTimestamp, registerMcpTool, safeInt } from "../helpers.js";
import {
  getOpenCodeHistoryPaths,
  type OpenCodeHistoryPaths,
} from "../history-paths.js";
import { snapshotDefaults, type HarnessMetricStrategies } from "../metric-strategies.js";
import {
  createTokenUsage,
  Harness,
  type SessionMeta,
  type ToolCallSummary,
} from "../models.js";
import { PlanModeTracker, TimeSpanTracker, type TimeSpan, type ToolSpan } from "../trackers.js";

export class OpenCodeParser extends HarnessParser {
  readonly harnessType = Harness.OPENCODE;

  private readonly _paths: OpenCodeHistoryPaths;
  private readonly _strategies: HarnessMetricStrategies;

  constructor() {
    super();
    this._paths = getOpenCodeHistoryPaths();
    this._strategies = snapshotDefaults();
  }

  parse(since?: Date): SessionMeta[] {
    return parseOpenCode(since, this, this._paths);
  }

  metricStrategies(): HarnessMetricStrategies {
    return this._strategies;
  }
}

function parseOpenCode(
  since: Date | undefined,
  parser: OpenCodeParser,
  paths: OpenCodeHistoryPaths,
): SessionMeta[] {
  const dbPath = paths.dbPath;
  if (!fs.existsSync(dbPath)) return [];

  const results: SessionMeta[] = [];

  try {
    const db = new Database(dbPath, { readonly: true });

    let query =
      "SELECT id, project_id, parent_id, title, directory, time_created, permission FROM session";
    const params: unknown[] = [];
    if (since) {
      query += " WHERE time_created >= ?";
      params.push(Math.floor(since.getTime()));
    }

    const sessions = db.prepare(query).all(...params) as Record<string, unknown>[];

    // Count subagent spawns per parent session
    const spawnCounts = new Map<string, number>();
    for (const s of sessions) {
      const parent = s.parent_id;
      if (parent) {
        const parentStr = String(parent);
        spawnCounts.set(parentStr, (spawnCounts.get(parentStr) ?? 0) + 1);
      }
    }

    for (const sessionRow of sessions) {
      const sessionId = String(sessionRow.id);
      const parentId = sessionRow.parent_id ? String(sessionRow.parent_id) : null;
      const projectName = basenameOnly(sessionRow.directory as string | null);
      const startedAt = parseTimestamp(sessionRow.time_created);

      // Detect plan mode from permission field
      let planEntries = 0;
      try {
        const perms = sessionRow.permission
          ? JSON.parse(sessionRow.permission as string)
          : [];
        if (Array.isArray(perms)) {
          for (const perm of perms) {
            if (
              typeof perm === "object" &&
              perm !== null &&
              (perm as Record<string, unknown>).permission === "plan_enter" &&
              (perm as Record<string, unknown>).action === "allow"
            ) {
              planEntries = 1;
            }
          }
        }
      } catch {
        // ignore
      }

      // Aggregate message metadata
      const msgRows = db
        .prepare("SELECT data FROM message WHERE session_id = ?")
        .all(sessionRow.id) as { data: unknown }[];

      let userCount = 0;
      let assistantCount = 0;
      let totalCount = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;
      let model = "unknown";
      let provider: string | null = null;
      let endedAt = "";
      const agentNames = new Set<string>();
      const skillInvocations: Record<string, Record<string, unknown>> = {};

      for (const msgRow of msgRows) {
        totalCount++;
        let data: Record<string, unknown>;
        try {
          data =
            typeof msgRow.data === "string" ? JSON.parse(msgRow.data) : {};
        } catch {
          continue;
        }

        const role = (data.role as string) ?? "";
        if (role === "user") userCount++;
        else if (role === "assistant") assistantCount++;

        // Track agent name for plan mode and subagent detection
        const agentName = (data.agent as string) ?? "";
        if (agentName && agentName !== "build" && agentName !== "") {
          agentNames.add(agentName);
        }

        // Model can be at data.modelID or data.model.modelID
        let m: unknown = data.modelID ?? data.model;
        if (typeof m === "object" && m !== null) {
          m = (m as Record<string, unknown>).modelID;
        }
        if (m) model = String(m);

        // Provider
        const p = data.providerID;
        if (p) provider = String(p);

        // Timestamps for end time
        const timeInfo = (data.time ?? {}) as Record<string, unknown>;
        const completed = timeInfo.completed;
        if (completed) endedAt = parseTimestamp(completed);

        const tokens = (data.tokens ?? {}) as Record<string, unknown>;
        inputTokens += safeInt(tokens.input);
        outputTokens += safeInt(tokens.output);

        const c = data.cost;
        if (c != null) {
          const costVal = Number(c);
          if (!Number.isNaN(costVal)) cost += costVal;
        }
      }

      // Build time spans from message timestamps
      const timeTracker = new TimeSpanTracker();
      const planTracker = new PlanModeTracker();
      let inPlanMode = false;

      const orderedMsgRows = db
        .prepare(
          "SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
        )
        .all(sessionRow.id) as { time_created: number; data: unknown }[];

      for (const msgRow2 of orderedMsgRows) {
        let mdata: Record<string, unknown>;
        try {
          mdata =
            typeof msgRow2.data === "string" ? JSON.parse(msgRow2.data) : {};
        } catch {
          continue;
        }
        const msgDt = new Date(msgRow2.time_created);
        const msgRole = (mdata.role as string) ?? "";
        const msgAgent = (mdata.agent as string) ?? "";
        if (msgRole === "user") {
          timeTracker.onUserTurn(msgDt);
        } else if (msgRole === "assistant") {
          timeTracker.onNonuserEvent(msgDt);
        }
        // Track plan mode transitions by agent field changes
        if (msgAgent === "plan" && !inPlanMode) {
          inPlanMode = true;
          planTracker.onEnter(msgDt);
        } else if (msgAgent !== "plan" && inPlanMode) {
          inPlanMode = false;
          planTracker.onExit(msgDt);
        }
      }

      if (inPlanMode && timeTracker.lastNonuserTimestamp) {
        planTracker.onExit(timeTracker.lastNonuserTimestamp);
      }

      const { timeSpans, turnExecTimes } = timeTracker.finalize();
      // Add plan mode spans
      for (const ps of planTracker.spans) {
        timeSpans.push(ps);
      }
      // Replace harness_exec with plan_mode for session-level plan
      planTracker.replaceSessionLevel(
        timeSpans,
        Math.max(planEntries, agentNames.has("plan") ? 1 : 0),
      );

      // Count tool-type parts and extract tool spans
      const partRows = db
        .prepare(
          `SELECT p.data FROM part p
           JOIN message m ON p.message_id = m.id
           WHERE m.session_id = ?`,
        )
        .all(sessionRow.id) as { data: unknown }[];

      let toolCallCount = 0;
      const toolCounts = new Map<string, number>();
      const toolCategories = new Map<string, string>();
      let subagentCalls = 0;
      let backgroundAgents = 0;
      let mcpCalls = 0;
      let planModeEntries = 0;
      let planModeExits = 0;
      const mcpServers: Record<string, Record<string, unknown>> = {};

      for (const partRow of partRows) {
        let pdata: Record<string, unknown>;
        try {
          pdata =
            typeof partRow.data === "string" ? JSON.parse(partRow.data) : {};
        } catch {
          continue;
        }

        const ptype = (pdata.type as string) ?? "";
        let isTool = false;
        let toolName = "unknown_tool";

        if (ptype === "tool-call" || ptype === "tool_use" || ptype === "function_call") {
          toolName = (pdata.toolName as string) ?? (pdata.name as string) ?? "unknown_tool";
          isTool = true;
        } else if (ptype === "tool" && "tool" in pdata) {
          toolName = pdata.tool as string;
          isTool = true;
        }

        // Detect skill invocations: tool="skill" with state.input.name
        if (isTool && toolName === "skill") {
          const state = pdata.state as Record<string, unknown> | undefined;
          if (typeof state === "object" && state !== null) {
            const meta = (state.metadata ?? {}) as Record<string, unknown>;
            const stateInput = (state.input ?? {}) as Record<string, unknown>;
            const skillName =
              (stateInput.name as string) ?? (meta.name as string) ?? "";
            if (skillName) {
              const skillDir = (meta.dir as string) ?? "";
              let source: string;
              if (skillDir.includes(".claude/skills/")) {
                source = "user-custom";
              } else if (
                skillDir.includes("/.opencode/") ||
                skillDir.includes("plugins")
              ) {
                source = "marketplace";
              } else {
                source = "user-custom";
              }
              const existing = (skillInvocations[skillName] ?? {
                count: 0,
                source,
              }) as Record<string, unknown>;
              skillInvocations[skillName] = {
                count: ((existing.count as number) ?? 0) + 1,
                source,
              };
            }
          }
        }

        if (isTool) {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          toolCallCount++;

          // Classify tool category
          if (toolName === "skill") {
            toolCategories.set(toolName, "skill");
          } else if (toolName === "task") {
            toolCategories.set(toolName, "subagent");
          } else if (toolName.startsWith("mcp_") || toolName.startsWith("mcp__")) {
            toolCategories.set(toolName, "mcp");
          } else if (!toolCategories.has(toolName)) {
            toolCategories.set(toolName, "tool");
          }

          // Extract tool span timing from state.time
          const state = pdata.state as Record<string, unknown> | undefined;
          if (typeof state === "object" && state !== null) {
            const timeInfo = state.time as Record<string, unknown> | undefined;
            if (
              typeof timeInfo === "object" &&
              timeInfo !== null &&
              timeInfo.start &&
              timeInfo.end
            ) {
              try {
                const tStart = new Date(Number(timeInfo.start));
                const tEnd = new Date(Number(timeInfo.end));
                const dur = (tEnd.getTime() - tStart.getTime()) / 1000;
                if (dur >= 0) {
                  // Find which harness_exec span this tool falls in
                  for (const sp of timeSpans) {
                    if (sp.type === "harness_exec" || sp.type === "plan_mode") {
                      const spStart = new Date(sp.start);
                      const spEnd = new Date(sp.end);
                      if (spStart <= tStart && tStart <= spEnd) {
                        if (!sp.tool_spans) sp.tool_spans = [];
                        (sp.tool_spans as ToolSpan[]).push({
                          name: toolName,
                          category: "tool",
                          start: tStart.toISOString(),
                          end: tEnd.toISOString(),
                          seconds: Math.round(dur * 1000) / 1000,
                        });
                        break;
                      }
                    }
                  }
                }
              } catch {
                // ignore
              }
            }
          }

          let toolInput = (pdata.args ?? pdata.input ?? {}) as Record<string, unknown>;
          // OpenCode nests input in state.input
          if (typeof toolInput !== "object" || toolInput === null) {
            const stateObj = pdata.state as Record<string, unknown> | undefined;
            toolInput =
              typeof stateObj === "object" && stateObj !== null
                ? ((stateObj.input ?? {}) as Record<string, unknown>)
                : {};
          }
          if (typeof toolInput !== "object" || toolInput === null) toolInput = {};

          const c = parser.classifyToolCall(toolName, toolInput);
          if (c.is_subagent) {
            subagentCalls++;
            if (c.is_background_agent) backgroundAgents++;
          }
          if (c.is_mcp) {
            mcpCalls++;
            registerMcpTool(mcpServers, toolName);
          }
          if (c.is_plan_enter) planModeEntries++;
          if (c.is_plan_exit) planModeExits++;
        }
      }

      if (totalCount === 0) continue;

      // Duration
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

      const toolCallSummaries: ToolCallSummary[] = [...toolCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({
          tool_name: name,
          invocation_count: count,
          category: toolCategories.get(name) ?? "tool",
        }));

      results.push(
        parser.sessionFromSnapshot({
          id: makeSessionId(Harness.OPENCODE, sessionId),
          source_session_id: sessionId,
          parent_session_id: parentId,
          agent_name: parentId
            ? [...agentNames].find((a) => a !== "plan") ?? null
            : null,
          harness_version: null,
          project_name: projectName,
          git_repo_name: projectName,
          git_branch: null,
          model,
          provider,
          message_count_user: userCount,
          message_count_assistant: assistantCount,
          message_count_total: totalCount,
          tool_call_count: toolCallCount,
          tokens: createTokenUsage({
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          }),
          subagent_calls: Math.max(subagentCalls, spawnCounts.get(sessionId) ?? 0),
          background_agents: backgroundAgents,
          mcp_calls: mcpCalls,
          mcp_servers: mcpServers,
          plan_mode_entries: Math.max(
            planEntries,
            planModeEntries,
            agentNames.has("plan") ? 1 : 0,
          ),
          plan_mode_exits: Math.max(
            planEntries,
            planModeExits,
            agentNames.has("plan") ? 1 : 0,
          ),
          tool_calls: toolCallSummaries,
          skills_used: skillInvocations,
          cost_usd: cost > 0 ? cost : null,
          started_at: startedAt,
          ended_at: endedAt || null,
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

    db.close();
  } catch {
    // ignore sqlite errors
  }

  return results;
}
