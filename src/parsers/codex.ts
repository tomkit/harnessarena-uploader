import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { HarnessParser } from "../base-parser.js";
import { getCodexHistoryPaths, type CodexHistoryPaths } from "../history-paths.js";
import { snapshotDefaults, type HarnessMetricStrategies } from "../metric-strategies.js";
import { basenameOnly, makeSessionId, parseTimestamp, safeInt } from "../helpers.js";
import {
  Harness,
  createSubagentMeta,
  createTokenUsage,
  type SessionMeta,
  type SubagentMeta,
  type TokenUsage,
  type ToolCallSummary,
} from "../models.js";
import {
  PlanModeTracker,
  SubagentCollector,
  TimeSpanTracker,
  ToolClassifier,
  type TimeSpan,
} from "../trackers.js";

/**
 * Recursively find files matching a pattern under a directory.
 */
function rglob(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...rglob(fullPath, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Codex CLI session parser.
 *
 * Codex JSONL stores events as {type, payload, timestamp} envelopes.
 * Tool calls appear as response_item with payload.type == "function_call"
 * and payload.name == tool name (e.g. "shell", "read_file").
 * Plugins registered in ~/.codex/config.toml provide MCP tools
 * (e.g. github@openai-curated -> mcp__codex_apps__github_*).
 */
export class CodexParser extends HarnessParser {
  readonly harnessType = Harness.CODEX;

  private _paths: CodexHistoryPaths;
  private _pluginNames: Set<string>;
  private _strategies: HarnessMetricStrategies;

  constructor() {
    super();
    this._paths = getCodexHistoryPaths();
    // Build plugin registry from config.toml
    this._pluginNames = new Set<string>();
    const configPath = this._paths.configPath;
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        for (const rawLine of content.split("\n")) {
          const line = rawLine.trim();
          if (line.startsWith("[plugins.")) {
            const name = line.includes('"') ? line.split('"')[1] : "";
            if (name) {
              this._pluginNames.add(name.split("@")[0]);
            }
          }
        }
      } catch {
        // ignore
      }
    }
    this._strategies = snapshotDefaults();
  }

  detectSubagent(toolName: string, _toolInput: Record<string, unknown>): boolean {
    return toolName === "spawn_agent";
  }

  detectSkill(toolName: string, _toolInput: Record<string, unknown>): string | null {
    // Codex plugin tools appear as mcp__codex_apps__<plugin>_<action>
    if (toolName.startsWith("mcp__codex_apps__")) {
      const parts = toolName.split("__");
      if (parts.length >= 3) {
        const pluginTool = parts[2]; // e.g. "github_get_profile"
        const pluginName = pluginTool.split("_")[0]; // e.g. "github"
        if (this._pluginNames.has(pluginName)) {
          return pluginName;
        }
      }
    }
    return null;
  }

  parse(since?: Date): SessionMeta[] {
    return parseCodex(since, this);
  }

  metricStrategies(): HarnessMetricStrategies {
    return this._strategies;
  }

  /** Expose paths for the parse function */
  get paths(): CodexHistoryPaths {
    return this._paths;
  }
}

function parseCodex(since: Date | undefined, parser: CodexParser): SessionMeta[] {
  /**
   * Parse Codex SQLite database + JSONL session files.
   *
   * SQLite: ~/.codex/state_5.sqlite table `threads`
   * Sessions: ~/.codex/sessions/{y}/{m}/{d}/rollout-*.jsonl
   */
  const dbPath = parser.paths.stateDbPath;
  if (!fs.existsSync(dbPath)) return [];

  const results: SessionMeta[] = [];

  try {
    const db = new Database(dbPath, { readonly: true });

    // created_at in Codex is Unix epoch seconds (integer)
    let query = `
      SELECT id, cwd, model, title, tokens_used, source,
             cli_version, git_sha, git_branch, created_at,
             sandbox_policy
      FROM threads
    `;
    const params: unknown[] = [];
    if (since) {
      query += " WHERE created_at >= ?";
      params.push(Math.floor(since.getTime() / 1000));
    }

    const threadRows = db.prepare(query).all(...params) as Record<string, unknown>[];

    // Count subagent spawns per parent thread from thread_spawn_edges
    const spawnCounts = new Map<string, number>();
    try {
      const edges = db
        .prepare("SELECT parent_thread_id, COUNT(*) as cnt FROM thread_spawn_edges GROUP BY parent_thread_id")
        .all() as Record<string, unknown>[];
      for (const e of edges) {
        spawnCounts.set(String(e.parent_thread_id), Number(e.cnt));
      }
    } catch {
      // table may not exist in older versions
    }

    for (const row of threadRows) {
      const sourceId = String(row.id);
      const model = row.model ? String(row.model) : "unknown";
      const totalTokens = safeInt(row.tokens_used);
      const projectName = basenameOnly(row.cwd as string | null);
      const gitBranch = row.git_branch as string | null;
      const harnessVersion = row.cli_version;
      const startedAt = parseTimestamp(row.created_at);

      // Detect plan mode from sandbox_policy: read-only = plan mode
      let planEntries = 0;
      try {
        const sandbox = row.sandbox_policy ? JSON.parse(String(row.sandbox_policy)) : {};
        if (typeof sandbox === "object" && sandbox !== null && sandbox.type === "read-only") {
          planEntries = 1;
        }
      } catch {
        // ignore
      }

      // Subagent count from thread_spawn_edges
      const subCount = spawnCounts.get(sourceId) ?? 0;

      results.push(
        parser.sessionFromSnapshot({
          id: makeSessionId(Harness.CODEX, sourceId),
          source_session_id: sourceId,
          harness_version: harnessVersion != null ? String(harnessVersion) : null,
          project_name: projectName,
          git_repo_name: projectName,
          git_branch: gitBranch,
          model,
          provider: "openai",
          tokens: createTokenUsage({ total_tokens: totalTokens }),
          subagent_calls: subCount,
          plan_mode_entries: planEntries,
          plan_mode_exits: planEntries,
          started_at: startedAt,
        }),
      );
    }

    db.close();
  } catch {
    // sqlite error
  }

  // Enrich sessions from JSONL rollout files
  const sessionLookup = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    sessionLookup.set(results[i].source_session_id, i);
  }

  const sessionsDir = parser.paths.sessionsDir;
  if (fs.existsSync(sessionsDir)) {
    const jsonlFiles = rglob(sessionsDir, /^rollout-.*\.jsonl$/);

    for (const jsonlFile of jsonlFiles) {
      try {
        let userCount = 0;
        let assistantCount = 0;
        let totalCount = 0;
        let toolCount = 0;
        let lastTokenUsage: Record<string, unknown> | null = null;
        let prevNcIn = 0; // previous cumulative non-cached input
        let prevOut = 0; // previous cumulative output
        let jsonlSessionId: string | null = null;
        let jsonlProject: string | null = null;
        let jsonlVersion: string | null = null;
        let jsonlStarted: string | null = null;

        // Tracker instances
        const timeTracker = new TimeSpanTracker();
        const planTracker = new PlanModeTracker();
        const toolClassifier = new ToolClassifier();
        const subagentCollector = new SubagentCollector();

        // Subagent metadata from session_meta
        let _isSubagent = false;
        let _agentNickname = "";
        let _agentRole = "";
        let _agentDepth = 0;
        let _forkedFromId: string | null = null;

        const fileContent = fs.readFileSync(jsonlFile, "utf-8");
        const lines = fileContent.split("\n");

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const entryType = (entry.type as string) ?? "";
          const payload = entry.payload as Record<string, unknown> | undefined;
          if (!payload || typeof payload !== "object") continue;

          const entryTs = entry.timestamp as string | undefined;
          let entryDt: Date | null = null;
          if (entryTs) {
            try {
              const d = new Date(String(entryTs).replace("Z", "+00:00"));
              if (!Number.isNaN(d.getTime())) entryDt = d;
            } catch {
              // ignore
            }
          }

          if (entryType === "session_meta") {
            if (jsonlSessionId === null) {
              // only take first session_meta
              jsonlSessionId = (payload.id as string) ?? null;
              // Capture subagent metadata if this is a forked session
              if (payload.forked_from_id) {
                _isSubagent = true;
                _forkedFromId = payload.forked_from_id as string;
                _agentNickname = (payload.agent_nickname as string) ?? "";
                _agentRole = (payload.agent_role as string) ?? "";
                const source = payload.source as Record<string, unknown> | undefined;
                if (source && typeof source === "object") {
                  const subagent = source.subagent as Record<string, unknown> | undefined;
                  const spawn = subagent?.thread_spawn as Record<string, unknown> | undefined;
                  _agentDepth = (spawn?.depth as number) ?? 1;
                }
              }
            }
            jsonlProject = basenameOnly(payload.cwd as string | null);
            jsonlVersion = (payload.cli_version as string) ?? null;
            jsonlStarted = parseTimestamp(payload.timestamp);
          } else if (entryType === "response_item") {
            const ptype = (payload.type as string) ?? "";
            if (ptype === "message") {
              const role = (payload.role as string) ?? "";
              if (role === "user") {
                userCount++;
                if (entryDt) timeTracker.onUserTurn(entryDt);
              } else if (role === "assistant") {
                assistantCount++;
                if (entryDt) timeTracker.onNonuserEvent(entryDt);
              }
              totalCount++;
            } else if (ptype === "function_call") {
              const toolName = (payload.name as string) ?? "unknown";
              toolCount++;

              // Classify via tracker
              const category = toolClassifier.record(toolName, {}, parser, {
                timestampDt: entryDt ?? undefined,
                planTracker,
              });

              // Codex-specific: capture spawn_agent metadata
              const c = parser.classifyToolCall(toolName, {});
              if (c.is_subagent && toolName === "spawn_agent") {
                let spawnArgs: Record<string, unknown> = {};
                try {
                  spawnArgs = JSON.parse((payload.arguments as string) ?? "{}") as Record<string, unknown>;
                } catch {
                  // ignore
                }
                subagentCollector.recordSpawn(
                  "foreground",
                  (spawnArgs.agent_type as string) ?? "",
                );
              }

              // Track tool call start
              const callId = (payload.call_id as string) ?? "";
              if (callId && entryDt) {
                timeTracker.onToolStart(callId, toolName, category, entryDt);
              }
            } else if (ptype === "function_call_output") {
              // Match tool call end
              const callId = (payload.call_id as string) ?? "";
              if (callId && entryDt) {
                const toolSpan = timeTracker.onToolEnd(callId, entryDt);
                if (toolSpan) {
                  planTracker.onToolSpan(toolSpan);
                }
              }
              if (entryDt) timeTracker.onNonuserEvent(entryDt);
            }
          } else if (entryType === "event_msg") {
            totalCount++;
            const evtType = payload.type as string | undefined;
            if (evtType === "token_count") {
              const info = payload.info as Record<string, unknown> | undefined;
              if (info && typeof info === "object") {
                const ttu = info.total_token_usage as Record<string, unknown> | undefined;
                if (ttu && typeof ttu === "object") {
                  lastTokenUsage = ttu;
                  // Compute non-cached token delta for per-span attribution
                  const curNcIn = Math.max(0, safeInt(ttu.input_tokens) - safeInt(ttu.cached_input_tokens));
                  const curOut = safeInt(ttu.output_tokens);
                  const deltaIn = Math.max(0, curNcIn - prevNcIn);
                  const deltaOut = Math.max(0, curOut - prevOut);
                  if (deltaIn > 0 || deltaOut > 0) {
                    timeTracker.onTokens(deltaIn, deltaOut);
                  }
                  prevNcIn = curNcIn;
                  prevOut = curOut;
                }
              }
            } else if (evtType === "exec_command_start") {
              const callId = (payload.call_id as string) ?? "";
              if (callId && entryDt) {
                timeTracker.onToolStart("exec:" + callId, "exec_command", "tool", entryDt);
              }
            } else if (evtType === "exec_command_end") {
              const callId = (payload.call_id as string) ?? "";
              const key = "exec:" + callId;
              if (entryDt) {
                timeTracker.onToolEnd(key, entryDt);
              }
              if (entryDt) {
                timeTracker.onNonuserEvent(entryDt);
              }
            } else if (evtType === "task_started") {
              // New turn boundary
              if (entryDt) {
                timeTracker.onUserTurn(entryDt);
              }
            }

            // Capture last turn
            if (entryDt) {
              timeTracker.onNonuserEvent(entryDt);
            }
          }
        }

        // Finalize time spans
        const { timeSpans } = timeTracker.finalize();
        // Append plan mode spans
        timeSpans.push(...planTracker.spans);

        // If session-level plan mode and no explicit plan spans, replace harness_exec with plan_mode
        let isSessionPlan = false;
        if (jsonlSessionId && sessionLookup.has(jsonlSessionId)) {
          isSessionPlan = results[sessionLookup.get(jsonlSessionId)!].plan_mode_entries > 0;
        }
        planTracker.replaceSessionLevel(timeSpans, isSessionPlan ? 1 : 0);

        // Enrich matching SQLite session, or create standalone
        if (jsonlSessionId && sessionLookup.has(jsonlSessionId)) {
          const idx = sessionLookup.get(jsonlSessionId)!;
          const old = results[idx];

          const d: Record<string, unknown> = { ...old };
          d.message_count_user = userCount;
          d.message_count_assistant = assistantCount;
          d.message_count_total = totalCount;
          d.tool_call_count = toolCount;

          if (lastTokenUsage) {
            const rawIn = safeInt(lastTokenUsage.input_tokens);
            const rawOut = safeInt(lastTokenUsage.output_tokens);
            const cached = safeInt(lastTokenUsage.cached_input_tokens);
            // Normalize: input_tokens = non-cached input (Claude convention)
            const nonCachedIn = Math.max(0, rawIn - cached);
            d.tokens = createTokenUsage({
              input_tokens: nonCachedIn,
              output_tokens: rawOut,
              cache_read_tokens: cached,
              cache_write_tokens: 0,
              total_tokens: nonCachedIn + rawOut,
            });
          }

          if (timeSpans.length > 0) {
            d.time_spans = timeSpans;
          }

          if (_forkedFromId) {
            d.parent_session_id = _forkedFromId;
            d.agent_name = _agentNickname || _agentRole || null;
          }

          d.subagent_calls = Math.max(old.subagent_calls, toolClassifier.subagentCalls);
          d.background_agents = toolClassifier.backgroundAgents;
          d.mcp_calls = toolClassifier.mcpCalls;
          d.plan_mode_entries = Math.max(old.plan_mode_entries, planTracker.entries);
          d.plan_mode_exits = Math.max(old.plan_mode_exits, planTracker.exits);

          d.tool_calls = [...toolClassifier.toolNames.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([n, c]): ToolCallSummary => ({
                tool_name: n,
                invocation_count: c,
                category: toolClassifier.toolCategories.get(n) ?? "tool",
              }),
            );

          d.skills_used = Object.fromEntries(
            [...toolClassifier.skillInvocations.entries()].map(([name, count]) => [
              name,
              { count, source: "plugin" },
            ]),
          );

          const oldMcpServers = (old.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
          const newMcpServers: Record<string, Record<string, unknown>> = {};
          for (const [name, info] of Object.entries(toolClassifier.mcpServers).sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            const primitives = (info.primitives ?? {}) as Record<string, Record<string, unknown>>;
            newMcpServers[name] = {
              count: info.invocation_count as number,
              uri: (info.uri as string) ?? null,
              primitives: Object.entries(primitives)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([primitiveName, primitiveInfo]) => ({
                  name: primitiveName,
                  type: (primitiveInfo.primitive_type as string) ?? "tool",
                  count: (primitiveInfo.invocation_count as number) ?? 0,
                })),
            };
          }
          d.mcp_servers = { ...oldMcpServers, ...newMcpServers };

          // Add subagent metadata (from spawn_agent calls in this session)
          if (subagentCollector.length > 0) {
            d.subagents = subagentCollector.finalize();
          }

          results[idx] = d as unknown as SessionMeta;
        }
      } catch {
        continue;
      }
    }
  }

  // Enrich parent sessions' subagent metadata with nicknames from child session_metas
  // Build a map: parent_id -> [(child_id, nickname, role, depth)]
  const childMeta = new Map<string, { child_id: string; nickname?: string; role?: string; depth?: number }[]>();
  try {
    const db = new Database(parser.paths.stateDbPath, { readonly: true });
    try {
      const edges = db
        .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges ORDER BY rowid")
        .all() as Record<string, unknown>[];
      for (const e of edges) {
        const pid = String(e.parent_thread_id);
        const cid = String(e.child_thread_id);
        if (!childMeta.has(pid)) {
          childMeta.set(pid, []);
        }
        childMeta.get(pid)!.push({ child_id: cid });
      }
    } catch {
      // ignore
    }
    db.close();
  } catch {
    // ignore
  }

  // Match nicknames from child session JSONL files
  if (fs.existsSync(sessionsDir)) {
    const jsonlFiles = rglob(sessionsDir, /^rollout-.*\.jsonl$/);
    for (const jsonlFile of jsonlFiles) {
      try {
        const content = fs.readFileSync(jsonlFile, "utf-8");
        for (const rawLine of content.split("\n")) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (entry.type === "session_meta") {
            const p = (entry.payload ?? {}) as Record<string, unknown>;
            const fid = p.forked_from_id as string | undefined;
            if (fid && childMeta.has(fid)) {
              const sid = (p.id as string) ?? "";
              for (const cm of childMeta.get(fid)!) {
                if (cm.child_id === sid) {
                  cm.nickname = (p.agent_nickname as string) ?? "";
                  cm.role = (p.agent_role as string) ?? "";
                  const source = p.source as Record<string, unknown> | undefined;
                  if (source && typeof source === "object") {
                    const subagent = source.subagent as Record<string, unknown> | undefined;
                    const spawn = subagent?.thread_spawn as Record<string, unknown> | undefined;
                    cm.depth = (spawn?.depth as number) ?? 1;
                  }
                  break;
                }
              }
            }
            break; // only need first session_meta
          }
        }
      } catch {
        continue;
      }
    }
  }

  // Now enrich parent sessions' SubagentMeta with nicknames
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const children = childMeta.get(r.source_session_id) ?? [];
    if (children.length === 0 && (!r.subagents || r.subagents.length === 0)) {
      continue;
    }
    // Build enriched subagent list
    const enriched: SubagentMeta[] = [...(r.subagents ?? [])];
    for (let ci = 0; ci < children.length; ci++) {
      const cm = children[ci];
      if (ci < enriched.length) {
        // Update existing entry with nickname/depth
        const oldSub = enriched[ci];
        enriched[ci] = createSubagentMeta({
          ordinal: oldSub.ordinal,
          parent_ordinal: oldSub.parent_ordinal,
          mode: oldSub.mode,
          subagent_type: oldSub.subagent_type || cm.role || "",
          nickname: cm.nickname ?? "",
          description: oldSub.description,
          depth: cm.depth ?? 1,
          total_tokens: oldSub.total_tokens,
          total_tool_calls: oldSub.total_tool_calls,
        });
      } else {
        enriched.push(
          createSubagentMeta({
            ordinal: ci,
            subagent_type: cm.role ?? "",
            nickname: cm.nickname ?? "",
            depth: cm.depth ?? 1,
          }),
        );
      }
    }
    if (enriched.length > 0) {
      const d: Record<string, unknown> = { ...r };
      d.subagents = enriched;
      results[i] = d as unknown as SessionMeta;
    }
  }

  return results;
}
