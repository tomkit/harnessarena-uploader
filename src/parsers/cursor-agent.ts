import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";

import { HarnessParser } from "../base-parser.js";
import { makeSessionId, registerMcpTool } from "../helpers.js";
import {
  getCursorHistoryPaths,
  type CursorHistoryPaths,
} from "../history-paths.js";
import { snapshotDefaults, type HarnessMetricStrategies } from "../metric-strategies.js";
import {
  createTokenUsage,
  Harness,
  type SessionMeta,
  type ToolCallSummary,
} from "../models.js";

export class CursorAgentParser extends HarnessParser {
  readonly harnessType = Harness.AGENT;

  private readonly _paths: CursorHistoryPaths;
  private readonly _strategies: HarnessMetricStrategies;

  constructor() {
    super();
    this._paths = getCursorHistoryPaths();
    this._strategies = snapshotDefaults();
  }

  parse(since?: Date): SessionMeta[] {
    return parseCursorAgent(since, this, this._paths);
  }

  metricStrategies(): HarnessMetricStrategies {
    return this._strategies;
  }
}

function parseCursorAgent(
  since: Date | undefined,
  parser: CursorAgentParser,
  paths: CursorHistoryPaths,
): SessionMeta[] {
  const cursorDir = paths.chatsDir;
  if (!fs.existsSync(cursorDir) || !fs.statSync(cursorDir).isDirectory()) {
    return [];
  }

  const results: SessionMeta[] = [];

  for (const hashEntry of fs.readdirSync(cursorDir, { withFileTypes: true })) {
    if (!hashEntry.isDirectory()) continue;
    const hashDir = path.join(cursorDir, hashEntry.name);

    for (const uuidEntry of fs.readdirSync(hashDir, { withFileTypes: true })) {
      if (!uuidEntry.isDirectory()) continue;
      const uuidDir = path.join(hashDir, uuidEntry.name);
      const dbPath = path.join(uuidDir, "store.db");
      if (!fs.existsSync(dbPath)) continue;

      try {
        const db = new Database(dbPath, { readonly: true });

        // The meta table stores hex-encoded JSON
        const row = db.prepare("SELECT * FROM meta LIMIT 1").get() as
          | Record<string, unknown>
          | undefined;
        if (!row) {
          db.close();
          continue;
        }

        // Try to decode the hex-encoded value
        let raw: Record<string, unknown> | null = null;
        for (const colName of Object.keys(row)) {
          const val = row[colName];
          if (typeof val === "string" && val.length > 20) {
            try {
              const decoded = Buffer.from(val, "hex").toString("utf-8");
              const parsed = JSON.parse(decoded);
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                raw = parsed as Record<string, unknown>;
                break;
              }
            } catch {
              // ignore
            }
          } else if (Buffer.isBuffer(val) && val.length > 20) {
            try {
              const parsed = JSON.parse(val.toString("utf-8"));
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                raw = parsed as Record<string, unknown>;
                break;
              }
            } catch {
              // ignore
            }
          }
        }

        if (!raw) {
          db.close();
          continue;
        }

        const sourceId = (raw.agentId as string) ?? uuidEntry.name;
        const model = (raw.lastUsedModel as string) ?? "unknown";
        const createdAt = raw.createdAt;

        if (since && createdAt) {
          try {
            const ts = new Date(String(createdAt).replace("Z", "+00:00"));
            if (ts.getTime() < since.getTime()) {
              db.close();
              continue;
            }
          } catch {
            // ignore
          }
        }

        // Detect plan mode from meta.mode field
        const sessionMode = (raw.mode as string) ?? "default";
        const isPlanMode = sessionMode === "plan";

        // Parse blobs for message counts, tool calls, and token estimation.
        const CHARS_PER_TOKEN = 4;
        let userCount = 0;
        let assistantCount = 0;
        let totalCount = 0;
        let toolCallCount = 0;
        const toolNames = new Map<string, number>();
        let subagentCalls = 0;
        let backgroundAgents = 0;
        let mcpCalls = 0;
        let planModeEntries = 0;
        let planModeExits = 0;
        let estimatedInputTokens = 0;
        let estimatedOutputTokens = 0;
        const mcpServers: Record<string, Record<string, unknown>> = {};

        try {
          const blobRows = db.prepare("SELECT data FROM blobs").all() as {
            data: unknown;
          }[];
          for (const blobRow of blobRows) {
            const blobData = blobRow.data;
            let msg: Record<string, unknown>;
            try {
              if (Buffer.isBuffer(blobData)) {
                msg = JSON.parse(blobData.toString("utf-8"));
              } else if (typeof blobData === "string") {
                msg = JSON.parse(Buffer.from(blobData, "hex").toString("utf-8"));
              } else {
                continue;
              }
            } catch {
              continue;
            }
            if (typeof msg !== "object" || msg === null || Array.isArray(msg)) continue;

            const role = (msg.role as string) ?? "";
            // Estimate tokens from content length
            let contentLen = 0;
            const content = msg.content;
            if (typeof content === "string") {
              contentLen = content.length;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === "object" && block !== null) {
                  const text = (block as Record<string, unknown>).text;
                  if (typeof text === "string") contentLen += text.length;
                }
              }
            }

            if (role === "user") {
              userCount++;
              estimatedInputTokens += Math.floor(contentLen / CHARS_PER_TOKEN);
            } else if (role === "assistant") {
              assistantCount++;
              estimatedOutputTokens += Math.floor(contentLen / CHARS_PER_TOKEN);
            } else if (role === "tool") {
              estimatedInputTokens += Math.floor(contentLen / CHARS_PER_TOKEN);
            } else if (role === "system") {
              estimatedInputTokens += Math.floor(contentLen / CHARS_PER_TOKEN);
            }
            totalCount++;

            // Extract tool calls from content blocks
            const contentBlocks = msg.content;
            if (Array.isArray(contentBlocks)) {
              for (const block of contentBlocks) {
                if (typeof block !== "object" || block === null) continue;
                const blockObj = block as Record<string, unknown>;
                if (blockObj.type === "tool-call") {
                  const toolName = (blockObj.toolName as string) ?? "unknown";
                  toolCallCount++;
                  toolNames.set(toolName, (toolNames.get(toolName) ?? 0) + 1);

                  let toolInput = (blockObj.args ?? {}) as Record<string, unknown>;
                  if (typeof toolInput !== "object" || toolInput === null) toolInput = {};
                  const c = parser.classifyToolCall(toolName, toolInput);
                  if (c.is_subagent) subagentCalls++;
                  if (c.is_background_agent) backgroundAgents++;
                  if (c.is_mcp) {
                    mcpCalls++;
                    registerMcpTool(mcpServers, toolName);
                  }
                  if (c.is_plan_enter) planModeEntries++;
                  if (c.is_plan_exit) planModeExits++;
                }
              }
            }
          }
        } catch {
          // ignore sqlite errors
        }

        db.close();

        let startedAt = "";
        if (createdAt) {
          try {
            startedAt = new Date(Number(createdAt)).toISOString();
          } catch {
            startedAt = String(createdAt);
          }
        }

        const toolCallSummaries: ToolCallSummary[] = [...toolNames.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, c]) => ({
            tool_name: n,
            invocation_count: c,
            category: "tool",
          }));

        results.push(
          parser.sessionFromSnapshot({
            id: makeSessionId(Harness.AGENT, sourceId),
            source_session_id: sourceId,
            harness_version: null,
            project_name: null,
            git_repo_name: null,
            git_branch: null,
            model,
            provider: "cursor",
            message_count_user: userCount,
            message_count_assistant: assistantCount,
            message_count_total: totalCount,
            tool_call_count: toolCallCount,
            subagent_calls: subagentCalls,
            background_agents: backgroundAgents,
            mcp_calls: mcpCalls,
            mcp_servers: mcpServers,
            plan_mode_entries: Math.max(isPlanMode ? 1 : 0, planModeEntries),
            plan_mode_exits: Math.max(isPlanMode ? 1 : 0, planModeExits),
            tokens: createTokenUsage({
              input_tokens: estimatedInputTokens,
              output_tokens: estimatedOutputTokens,
              total_tokens: estimatedInputTokens + estimatedOutputTokens,
            }),
            tool_calls: toolCallSummaries,
            started_at: startedAt,
          }),
        );
      } catch {
        continue;
      }
    }
  }

  return results;
}
