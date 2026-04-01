import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

import { HarnessParser } from "../base-parser.js";
import { getClaudeHistoryPaths, type ClaudeHistoryPaths } from "../history-paths.js";
import {
  basenameOnly,
  decodeClaudeProjectDir,
  extractUserDisplayText,
  makePromptKey,
  makeSessionId,
  registerMcpTool,
} from "../helpers.js";
import { snapshotDefaults, type HarnessMetricStrategies } from "../metric-strategies.js";
import {
  Harness,
  createTokenUsage,
  type SessionMeta,
  type ToolCallSummary,
} from "../models.js";
import {
  DailyTracker,
  PlanModeTracker,
  SubagentCollector,
  TimeSpanTracker,
  ToolClassifier,
  type TimeSpan,
  type ToolSpan,
} from "../trackers.js";

export class ClaudeParser extends HarnessParser {
  readonly harnessType = Harness.CLAUDE;

  private _paths: ClaudeHistoryPaths;
  private _strategies: HarnessMetricStrategies;

  constructor() {
    super();
    this._paths = getClaudeHistoryPaths();
    this._strategies = snapshotDefaults();
  }

  detectSubagent(toolName: string, _toolInput: Record<string, unknown>): boolean {
    return toolName === "Agent";
  }

  detectBackgroundAgent(toolName: string, toolInput: Record<string, unknown>): boolean {
    return (
      toolName === "Agent" &&
      typeof toolInput === "object" &&
      toolInput !== null &&
      Boolean(toolInput.run_in_background)
    );
  }

  detectMcpCall(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  detectSkill(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (toolName === "Skill" && typeof toolInput === "object" && toolInput !== null) {
      return (toolInput.skill as string) ?? "unknown";
    }
    return null;
  }

  detectPlanModeEnter(toolName: string): boolean {
    return toolName === "EnterPlanMode";
  }

  detectPlanModeExit(toolName: string): boolean {
    return toolName === "ExitPlanMode";
  }

  parse(since?: Date): SessionMeta[] {
    return parseClaude(since, this, this._paths);
  }

  metricStrategies(): HarnessMetricStrategies {
    return this._strategies;
  }
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

function parseClaude(
  since: Date | undefined,
  parser: ClaudeParser,
  paths?: ClaudeHistoryPaths,
): SessionMeta[] {
  const results: SessionMeta[] = [];
  const seenSessionIds = new Set<string>();
  const allPromptKeys = new Set<string>();

  paths = paths ?? getClaudeHistoryPaths();
  const projectsDir = paths.projectsDir;

  // --- Source 1: JSONL sessions in ~/.claude/projects/ (rich data) ---
  if (fs.existsSync(projectsDir) && fs.statSync(projectsDir).isDirectory()) {
    for (const projectDirName of fs.readdirSync(projectsDir)) {
      const projectDirPath = path.join(projectsDir, projectDirName);
      if (!fs.statSync(projectDirPath).isDirectory()) continue;

      const projectName = decodeClaudeProjectDir(projectDirName);

      const jsonlFiles = fs
        .readdirSync(projectDirPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(projectDirPath, f));

      for (const jsonlFile of jsonlFiles) {
        try {
          const { session, promptKeys } = parseClaudeJsonl(
            jsonlFile,
            projectName,
            since,
            parser,
          );
          for (const k of promptKeys) allPromptKeys.add(k);
          if (session && !seenSessionIds.has(session.source_session_id)) {
            results.push(session);
            seenSessionIds.add(session.source_session_id);
          }
        } catch {
          continue;
        }
      }

      // --- Source 1b: sessions-index.json for pruned sessions ---
      const indexFile = path.join(projectDirPath, "sessions-index.json");
      if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
        try {
          const indexData = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
          for (const entry of indexData.entries ?? []) {
            const sourceId: string = entry.sessionId ?? "";
            if (!sourceId || seenSessionIds.has(sourceId)) continue;

            const created: string = entry.created ?? "";
            const modified: string = entry.modified ?? "";
            if (since && created) {
              try {
                const sessionStart = new Date(created.replace("Z", "+00:00"));
                if (sessionStart.getTime() < since.getTime()) continue;
              } catch {
                // ignore
              }
            }

            const idxProject = projectName;
            const msgCount: number = entry.messageCount ?? 0;
            let duration: number | null = null;
            if (created && modified) {
              try {
                const t1 = new Date(created.replace("Z", "+00:00"));
                const t2 = new Date(modified.replace("Z", "+00:00"));
                duration = Math.max(0, Math.floor((t2.getTime() - t1.getTime()) / 1000));
              } catch {
                // ignore
              }
            }

            results.push(
              parser.sessionFromSnapshot({
                id: makeSessionId(Harness.CLAUDE, sourceId),
                source_session_id: sourceId,
                harness_version: null,
                project_name: idxProject,
                git_repo_name: idxProject,
                git_branch: entry.gitBranch ?? null,
                model: "unknown",
                provider: "anthropic",
                message_count_user: 0,
                message_count_assistant: 0,
                message_count_total: msgCount,
                tool_call_count: 0,
                tokens: createTokenUsage(),
                data_completeness: "partial",
                is_pruned: true,
                started_at: created,
                ended_at: modified,
                duration_seconds: duration,
              }),
            );
            seenSessionIds.add(sourceId);
          }
        } catch {
          // continue
        }
      }
    }
  }

  // --- Source 1c: history.jsonl ---
  const historyFile = paths.historyPath;
  if (fs.existsSync(historyFile) && fs.statSync(historyFile).isFile()) {
    const historyNew = new Map<string, number[]>();
    try {
      const historyContent = fs.readFileSync(historyFile, "utf-8");
      for (const line of historyContent.split("\n")) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const projectPath = entry.project as string | undefined;
        const tsMs = entry.timestamp as number | undefined;
        const display = entry.display as string | undefined;
        if (!projectPath || !tsMs || !display) continue;

        if (since) {
          try {
            const entryDt = new Date(tsMs);
            if (entryDt.getTime() < since.getTime()) continue;
          } catch {
            continue;
          }
        }

        const promptKey = makePromptKey(display.slice(0, 100), tsMs);
        if (allPromptKeys.has(promptKey)) continue;
        allPromptKeys.add(promptKey);

        const projName = basenameOnly(projectPath);
        if (!projName) continue;

        if (!historyNew.has(projName)) {
          historyNew.set(projName, []);
        }
        historyNew.get(projName)!.push(tsMs);
      }
    } catch {
      historyNew.clear();
    }

    for (const [projName, timestamps] of historyNew) {
      if (timestamps.length === 0) continue;
      timestamps.sort((a, b) => a - b);
      const firstDay = new Date(timestamps[0]).toISOString().slice(0, 10);
      const lastDay = new Date(timestamps[timestamps.length - 1]).toISOString().slice(0, 10);
      const sourceId = `history-supplement-${projName}`;
      if (seenSessionIds.has(sourceId)) continue;

      results.push(
        parser.sessionFromSnapshot({
          id: makeSessionId(Harness.CLAUDE, sourceId),
          source_session_id: sourceId,
          harness_version: null,
          project_name: projName,
          git_repo_name: projName,
          git_branch: null,
          model: "unknown",
          provider: "anthropic",
          message_count_user: timestamps.length,
          message_count_assistant: 0,
          message_count_total: timestamps.length,
          tool_call_count: 0,
          tokens: createTokenUsage(),
          data_completeness: "prompts_only",
          is_pruned: true,
          started_at: `${firstDay}T00:00:00Z`,
          ended_at: `${lastDay}T23:59:59Z`,
          duration_seconds: null,
        }),
      );
      seenSessionIds.add(sourceId);
    }
  }

  // --- Source 2: Session metadata in Application Support (fallback) ---
  const fallbackDirs = [
    paths.appSessionsDir,
    path.join(homedir(), ".config", "Claude", "claude-code-sessions"),
  ];

  for (const sessionsDir of fallbackDirs) {
    if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) continue;

    const jsonFiles = findJsonFiles(sessionsDir);
    for (const jsonFile of jsonFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;

        const sourceId: string = data.sessionId ?? data.cliSessionId ?? "";
        if (!sourceId || seenSessionIds.has(sourceId)) continue;
        if (data.isArchived) continue;

        const createdMs: number | undefined = data.createdAt;
        if (since && createdMs) {
          const sessionStart = new Date(createdMs);
          if (sessionStart.getTime() < since.getTime()) continue;
        }

        let startedAt = "";
        let endedAt: string | null = null;
        let duration: number | null = null;
        if (createdMs) {
          startedAt = new Date(createdMs).toISOString();
        }
        const lastMs: number | undefined = data.lastActivityAt;
        if (lastMs) {
          endedAt = new Date(lastMs).toISOString();
        }
        if (createdMs && lastMs) {
          duration = Math.max(0, Math.floor((lastMs - createdMs) / 1000));
        }

        results.push(
          parser.sessionFromSnapshot({
            id: makeSessionId(Harness.CLAUDE, sourceId),
            source_session_id: sourceId,
            harness_version: null,
            project_name: basenameOnly(data.cwd ?? data.originCwd),
            git_repo_name: null,
            git_branch: null,
            model: data.model ?? "unknown",
            provider: "anthropic",
            message_count_user: 0,
            message_count_assistant: 0,
            message_count_total: 0,
            tool_call_count: 0,
            tokens: createTokenUsage(),
            started_at: startedAt,
            ended_at: endedAt,
            duration_seconds: duration,
          }),
        );
        seenSessionIds.add(sourceId);
      } catch {
        continue;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Recursively find .json files (equivalent to rglob("*.json"))
// ---------------------------------------------------------------------------

function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore permission errors etc.
  }
  return results;
}

// ---------------------------------------------------------------------------
// Parse a single JSONL session file
// ---------------------------------------------------------------------------

function getDate(ts: string | undefined | null): string | undefined {
  if (ts && ts.length >= 10) return ts.slice(0, 10);
  return undefined;
}

function parseIsoDate(ts: string): Date {
  return new Date(ts.replace("Z", "+00:00"));
}

interface ParseClaudeJsonlResult {
  session: SessionMeta | null;
  promptKeys: Set<string>;
}

function parseClaudeJsonl(
  jsonlPath: string,
  projectName: string | null,
  since: Date | undefined,
  parser: ClaudeParser,
): ParseClaudeJsonlResult {
  const sessionIdFromFile = path.basename(jsonlPath, ".jsonl");
  let sessionId = sessionIdFromFile;
  const promptKeys = new Set<string>();
  const versions = new Set<string>();
  const models = new Map<string, number>();
  let userCount = 0;
  let assistantCount = 0;
  let totalCount = 0;
  let toolCallCount = 0;

  // Tracker instances
  const timeTracker = new TimeSpanTracker();
  const planTracker = new PlanModeTracker();
  const dailyTracker = new DailyTracker();
  const toolClassifier = new ToolClassifier();
  const subagentCollector = new SubagentCollector();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let cwd: string | null = null;

  const fileContent = fs.readFileSync(jsonlPath, "utf-8");
  for (const line of fileContent.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryType = entry.type as string ?? "";
    const timestamp = entry.timestamp as string | undefined;
    const date = getDate(timestamp);
    if (timestamp) {
      if (!firstTs || timestamp < firstTs) firstTs = timestamp;
      if (!lastTs || timestamp > lastTs) lastTs = timestamp;
    }

    if (entryType === "user") {
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const content = msg.content;
      let isToolResult = false;

      if (Array.isArray(content)) {
        for (const b of content) {
          if (typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result") {
            isToolResult = true;
            const tuid = (b as Record<string, unknown>).tool_use_id as string ?? "";
            if (tuid && timestamp) {
              try {
                const endDt = parseIsoDate(timestamp);
                const toolSpan = timeTracker.onToolEnd(tuid, endDt);
                if (toolSpan) planTracker.onToolSpan(toolSpan);
              } catch {
                // ignore
              }
            }
          }
        }
      }

      if (!isToolResult && timestamp) {
        try {
          const thisDt = parseIsoDate(timestamp);
          timeTracker.onUserTurn(thisDt);
        } catch {
          // ignore
        }
      }

      userCount++;
      totalCount++;
      const v = entry.version as string | undefined;
      if (v) versions.add(v);
      if (!cwd) cwd = entry.cwd as string | undefined ?? null;
      const sid = entry.sessionId as string | undefined;
      if (sid) sessionId = sid;
      if (date) dailyTracker.add(date, { prompts: 1 });

      // Build prompt dedup key
      const display = extractUserDisplayText(entry);
      if (display && timestamp) {
        try {
          const dt = parseIsoDate(timestamp);
          const tsMs = dt.getTime();
          promptKeys.add(makePromptKey(display, tsMs));
        } catch {
          // ignore
        }
      }
    } else if (entryType === "assistant") {
      if (timestamp) {
        try {
          timeTracker.onNonuserEvent(parseIsoDate(timestamp));
        } catch {
          // ignore
        }
      }
      assistantCount++;
      totalCount++;
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const model = msg.model as string | undefined;
      if (model) {
        models.set(model, (models.get(model) ?? 0) + 1);
      }
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      const msgIn = (usage.input_tokens as number) ?? 0;
      const msgOut = (usage.output_tokens as number) ?? 0;
      inputTokens += msgIn;
      outputTokens += msgOut;
      timeTracker.onTokens(msgIn, msgOut);
      cacheRead += (usage.cache_read_input_tokens as number) ?? 0;
      cacheWrite += (usage.cache_creation_input_tokens as number) ?? 0;

      if (date) {
        dailyTracker.add(date, {
          tokens_in: msgIn,
          tokens_out: msgOut,
          tokens_total: msgIn + msgOut,
        });
      }

      // Count tool_use blocks
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type !== "tool_use") continue;
          toolCallCount++;
          const toolName = (blockObj.name as string) ?? "unknown";
          if (date) dailyTracker.add(date, { tool_calls: 1 });

          let toolInput = blockObj.input as Record<string, unknown> | undefined;
          if (typeof toolInput !== "object" || toolInput === null) toolInput = {};

          // Parse timestamp for plan tracker
          let tsDt: Date | undefined;
          if (timestamp) {
            try {
              tsDt = parseIsoDate(timestamp);
            } catch {
              // ignore
            }
          }

          // Classify tool call via tracker
          const category = toolClassifier.record(toolName, toolInput, parser, {
            timestampDt: tsDt,
            planTracker,
            timeTracker,
            subagentCollector,
            dailyTracker,
            date,
          });

          // Track tool call start for span timing
          const toolId = blockObj.id as string ?? "";
          if (toolId && tsDt) {
            timeTracker.onToolStart(toolId, toolName, category, tsDt);
          }
        }
      }
    } else if (entryType === "system") {
      if (timestamp) {
        try {
          timeTracker.onNonuserEvent(parseIsoDate(timestamp));
        } catch {
          // ignore
        }
      }
      totalCount++;

      // Detect marketplace plugins from hook summaries
      const subtype = entry.subtype as string ?? "";
      if (subtype === "stop_hook_summary") {
        const textsToCheck: string[] = [];
        const hookInfos = entry.hookInfos as Record<string, unknown>[] | undefined;
        if (Array.isArray(hookInfos)) {
          for (const hook of hookInfos) {
            textsToCheck.push((hook.command as string) ?? "");
          }
        }
        const hookErrors = entry.hookErrors as unknown[] | undefined;
        if (Array.isArray(hookErrors)) {
          for (const err of hookErrors) {
            if (typeof err === "string") textsToCheck.push(err);
          }
        }
        for (const text of textsToCheck) {
          if (text.includes("claude-plugins-official/")) {
            const idx = text.indexOf("claude-plugins-official/");
            const remainder = text.slice(idx + "claude-plugins-official/".length);
            const pluginName = remainder.split("/")[0];
            if (pluginName && pluginName !== "hooks" && pluginName !== "plugins" && pluginName !== "") {
              toolClassifier.skillInvocations.set(
                pluginName,
                (toolClassifier.skillInvocations.get(pluginName) ?? 0) + 1,
              );
              break;
            }
          }
        }
      }
    }
  }

  // Finalize time spans
  const { timeSpans, turnExecTimes } = timeTracker.finalize();
  // Append plan mode spans
  timeSpans.push(...planTracker.spans);

  // --- Parse subagent JSONL files ---
  let subagentsDir = path.join(path.dirname(jsonlPath), sessionId, "subagents");
  if (!fs.existsSync(subagentsDir) || !fs.statSync(subagentsDir).isDirectory()) {
    subagentsDir = path.join(path.dirname(jsonlPath), sessionIdFromFile, "subagents");
  }

  let subagentFiles: string[] = [];
  if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
    subagentFiles = fs
      .readdirSync(subagentsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(subagentsDir, f));
  }

  const subagentCalls = Math.max(toolClassifier.subagentCalls, subagentFiles.length);

  if (subagentFiles.length > 0) {
    for (let subIdx = 0; subIdx < subagentFiles.length; subIdx++) {
      const subJsonl = subagentFiles[subIdx];
      let subTokens = 0;
      let subToolCalls = 0;
      try {
        const subContent = fs.readFileSync(subJsonl, "utf-8");
        for (const subLine of subContent.split("\n")) {
          if (!subLine.trim()) continue;
          let subEntry: Record<string, unknown>;
          try {
            subEntry = JSON.parse(subLine);
          } catch {
            continue;
          }

          const subEntryType = subEntry.type as string ?? "";
          const subTimestamp = subEntry.timestamp as string | undefined;
          const subDate = getDate(subTimestamp);
          if (subTimestamp) {
            if (!lastTs || subTimestamp > lastTs) lastTs = subTimestamp;
          }

          if (subEntryType === "assistant") {
            assistantCount++;
            totalCount++;
            const subMsg = (subEntry.message ?? {}) as Record<string, unknown>;
            const subModel = subMsg.model as string | undefined;
            if (subModel) {
              models.set(subModel, (models.get(subModel) ?? 0) + 1);
            }
            const subUsage = (subMsg.usage ?? {}) as Record<string, unknown>;
            const subMsgIn = (subUsage.input_tokens as number) ?? 0;
            const subMsgOut = (subUsage.output_tokens as number) ?? 0;
            inputTokens += subMsgIn;
            outputTokens += subMsgOut;
            subTokens += subMsgIn + subMsgOut;
            cacheRead += (subUsage.cache_read_input_tokens as number) ?? 0;
            cacheWrite += (subUsage.cache_creation_input_tokens as number) ?? 0;
            if (subDate) {
              dailyTracker.add(subDate, {
                tokens_in: subMsgIn,
                tokens_out: subMsgOut,
                tokens_total: subMsgIn + subMsgOut,
              });
            }

            const subContent2 = subMsg.content;
            if (Array.isArray(subContent2)) {
              for (const block of subContent2) {
                if (typeof block !== "object" || block === null) continue;
                const blockObj = block as Record<string, unknown>;
                if (blockObj.type !== "tool_use") continue;
                toolCallCount++;
                subToolCalls++;
                const toolName = (blockObj.name as string) ?? "unknown";
                toolClassifier.toolNames.set(toolName, (toolClassifier.toolNames.get(toolName) ?? 0) + 1);
                if (subDate) dailyTracker.add(subDate, { tool_calls: 1 });

                let ti = blockObj.input as Record<string, unknown> | undefined;
                if (typeof ti !== "object" || ti === null) ti = {};
                const c = parser.classifyToolCall(toolName, ti);
                if (c.is_mcp) {
                  toolClassifier.mcpCalls++;
                  registerMcpTool(toolClassifier.mcpServers, toolName);
                  if (subDate) dailyTracker.add(subDate, { mcp_calls: 1 });
                }
              }
            }
          } else if (subEntryType === "user") {
            totalCount++;
          } else if (subEntryType === "system") {
            // Detect marketplace plugins from hook summaries in subagents
            const subtype = subEntry.subtype as string ?? "";
            if (subtype === "stop_hook_summary") {
              const hookInfos = subEntry.hookInfos as Record<string, unknown>[] | undefined;
              if (Array.isArray(hookInfos)) {
                for (const hook of hookInfos) {
                  const cmd = (hook.command as string) ?? "";
                  if (cmd.includes("claude-plugins-official/") || cmd.includes("plugins/cache/")) {
                    const parts = cmd.split("/");
                    for (let i = 0; i < parts.length; i++) {
                      if (
                        (parts[i] === "claude-plugins-official" || parts[i] === "cache") &&
                        i + 1 < parts.length
                      ) {
                        const pluginName = parts[i + 1];
                        if (pluginName && pluginName !== "hooks") {
                          toolClassifier.skillInvocations.set(
                            pluginName,
                            (toolClassifier.skillInvocations.get(pluginName) ?? 0) + 1,
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        continue;
      }
      // Enrich matching subagent meta with per-file metrics
      subagentCollector.enrich(subIdx, subTokens, subToolCalls);
    }
  }

  // Fill in any subagent metas discovered from directory but not from tool_use
  subagentCollector.ensureCount(subagentFiles.length);

  if (userCount === 0 && assistantCount === 0) {
    return { session: null, promptKeys };
  }

  // Apply --since filter
  if (since && firstTs) {
    try {
      const sessionStart = parseIsoDate(firstTs);
      if (sessionStart.getTime() < since.getTime()) {
        return { session: null, promptKeys };
      }
    } catch {
      // ignore
    }
  }

  // Resolve project name from cwd if available
  if (cwd) {
    projectName = basenameOnly(cwd) ?? projectName;
  }

  // Most common model
  let topModel = "unknown";
  let topModelCount = 0;
  for (const [m, c] of models) {
    if (c > topModelCount) {
      topModel = m;
      topModelCount = c;
    }
  }

  // Version: use the set of versions seen
  const sortedVersions = [...versions].sort();
  let harnessVersion: string | null = null;
  if (sortedVersions.length === 1) {
    harnessVersion = sortedVersions[0];
  } else if (sortedVersions.length > 1) {
    harnessVersion = `${sortedVersions[0]}..${sortedVersions[sortedVersions.length - 1]}`;
  }

  // Timestamps
  const startedAt = firstTs ?? "";
  const endedAt = lastTs ?? null;
  let duration: number | null = null;
  if (firstTs && lastTs) {
    try {
      const t1 = parseIsoDate(firstTs);
      const t2 = parseIsoDate(lastTs);
      duration = Math.max(0, Math.floor((t2.getTime() - t1.getTime()) / 1000));
    } catch {
      // ignore
    }
  }

  const totalTokens = inputTokens + outputTokens;

  // Build tool summaries sorted by count descending
  const toolSummaries: ToolCallSummary[] = [...toolClassifier.toolNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      tool_name: name,
      invocation_count: count,
      category: toolClassifier.toolCategories.get(name) ?? "tool",
    }));

  // Build skills_used dict
  const marketplacePlugins = new Set<string>();
  const userPlugins = new Set<string>();
  const projectPlugins = new Set<string>();

  function collectPlugins(settingsPath: string, target: Set<string>): void {
    if (!fs.existsSync(settingsPath) || !fs.statSync(settingsPath).isFile()) return;
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const enabled = data.enabledPlugins;
      if (enabled && typeof enabled === "object") {
        for (const pid of Object.keys(enabled)) {
          if (pid.includes("@claude-plugins-official")) {
            const base = pid.split("@")[0];
            marketplacePlugins.add(base);
            target.add(base);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  collectPlugins(path.join(homedir(), ".claude", "settings.json"), userPlugins);
  if (cwd) {
    collectPlugins(path.join(cwd, ".claude", "settings.json"), projectPlugins);
    collectPlugins(path.join(cwd, ".claude", "settings.local.json"), projectPlugins);
  }

  const skills: Record<string, Record<string, unknown>> = {};
  const sortedSkills = [...toolClassifier.skillInvocations.entries()].sort((a, b) => b[1] - a[1]);
  for (const [skillName, count] of sortedSkills) {
    const baseName = skillName.split(":")[0];
    let source: string;
    let scope: string;
    let marketplace: string | null = null;

    if (marketplacePlugins.has(baseName)) {
      source = "marketplace";
      scope = projectPlugins.has(baseName) && !userPlugins.has(baseName) ? "project" : "user";
      marketplace = "claude-plugins-official";
    } else {
      source = "user-custom";
      scope = "user";
      // Check if Vercel skill
      const skillDir = path.join(homedir(), ".claude", "skills", baseName);
      if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
        const skillMd = path.join(skillDir, "SKILL.md");
        if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
          try {
            const mdContent = fs.readFileSync(skillMd, "utf-8");
            const mdLines = mdContent.split("\n").slice(0, 20);
            for (const mdLine of mdLines) {
              if (
                mdLine.trim().toLowerCase().startsWith("author:") &&
                mdLine.toLowerCase().includes("vercel")
              ) {
                source = "marketplace";
                marketplace = "vercel-labs";
                break;
              }
            }
          } catch {
            // ignore
          }
        }
      }
      if (cwd) {
        const projSkill = path.join(cwd, ".claude", "skills", skillName);
        if (fs.existsSync(projSkill) && fs.statSync(projSkill).isDirectory()) {
          source = "project-custom";
          scope = "project";
        }
      }
    }

    const skillEntry: Record<string, unknown> = { count, source, scope };
    if (marketplace) skillEntry.marketplace = marketplace;
    skills[skillName] = skillEntry;
  }

  // Mark first date as having 1 session
  if (firstTs) {
    const firstDate = getDate(firstTs);
    if (firstDate) dailyTracker.markSessionStart(firstDate);
  }

  const dailyList = dailyTracker.finalize();

  const session = parser.sessionFromSnapshot({
    id: makeSessionId(Harness.CLAUDE, sessionId),
    source_session_id: sessionId,
    harness_version: harnessVersion,
    project_name: projectName,
    git_repo_name: projectName,
    git_branch: null,
    model: topModel,
    provider: "anthropic",
    message_count_user: userCount,
    message_count_assistant: assistantCount,
    message_count_total: totalCount,
    tool_call_count: toolCallCount,
    subagent_calls: subagentCalls,
    background_agents: toolClassifier.backgroundAgents,
    mcp_calls: toolClassifier.mcpCalls,
    mcp_servers: toolClassifier.mcpServers,
    plan_mode_entries: planTracker.entries,
    plan_mode_exits: planTracker.exits,
    tokens: createTokenUsage({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: totalTokens,
    }),
    tool_calls: toolSummaries,
    skills_used: skills,
    daily: dailyList,
    cost_usd: null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: duration,
    total_exec_seconds: turnExecTimes.length > 0
      ? Math.round(turnExecTimes.reduce((a, b) => a + b, 0) * 10) / 10
      : null,
    mean_turn_seconds: turnExecTimes.length > 0
      ? Math.round((turnExecTimes.reduce((a, b) => a + b, 0) / turnExecTimes.length) * 10) / 10
      : null,
    median_turn_seconds: turnExecTimes.length > 0
      ? Math.round(turnExecTimes.sort((a, b) => a - b)[Math.floor(turnExecTimes.length / 2)] * 10) / 10
      : null,
    time_spans: timeSpans,
    subagents: subagentCollector.finalize(),
  });

  return { session, promptKeys };
}
