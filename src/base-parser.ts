import type { HarnessMetricStrategies } from "./metric-strategies.js";
import type { Harness, SessionMeta } from "./models.js";
import type { ToolClassification } from "./trackers.js";

export abstract class HarnessParser {
  abstract readonly harnessType: Harness;

  abstract parse(since?: Date): SessionMeta[];

  abstract metricStrategies(): HarnessMetricStrategies;

  // --- Concept detectors (override per harness) ---

  detectSubagent(_toolName: string, _toolInput: Record<string, unknown>): boolean {
    return false;
  }

  detectBackgroundAgent(_toolName: string, _toolInput: Record<string, unknown>): boolean {
    return false;
  }

  detectMcpCall(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  detectSkill(_toolName: string, _toolInput: Record<string, unknown>): string | null {
    return null;
  }

  detectPlanModeEnter(_toolName: string): boolean {
    return false;
  }

  detectPlanModeExit(_toolName: string): boolean {
    return false;
  }

  // --- Unified dispatch ---

  classifyToolCall(toolName: string, toolInput: Record<string, unknown>): ToolClassification {
    return {
      is_subagent: this.detectSubagent(toolName, toolInput),
      is_background_agent: this.detectBackgroundAgent(toolName, toolInput),
      is_mcp: this.detectMcpCall(toolName),
      skill_name: this.detectSkill(toolName, toolInput),
      is_plan_enter: this.detectPlanModeEnter(toolName),
      is_plan_exit: this.detectPlanModeExit(toolName),
    };
  }

  // --- Shared helpers ---

  static computeInterventionRate(userCount: number, toolCallCount: number): number | null {
    if (toolCallCount > 0) {
      return Math.round((userCount / toolCallCount) * 100) / 100;
    }
    return null;
  }

  sessionFromSnapshot(snapshot: Record<string, unknown>): SessionMeta {
    const metrics = this.metricStrategies();
    const promptMetric = metrics.prompts.parse(snapshot);
    const subagentMetric = metrics.subagents.parse(snapshot);
    const mcpMetric = metrics.mcp.parse(snapshot);
    const skillMetric = metrics.skills.parse(snapshot);
    const toolMetric = metrics.tools.parse(snapshot);
    const tokenMetric = metrics.tokens.parse(snapshot);
    const planMetric = metrics.plan.parse(snapshot);
    const dailyMetric = metrics.daily.parse(snapshot);
    const costMetric = metrics.cost.parse(snapshot);

    return {
      id: snapshot.id as string,
      source_session_id: snapshot.source_session_id as string,
      harness: this.harnessType,
      harness_version: (snapshot.harness_version as string) ?? null,
      project_name: (snapshot.project_name as string) ?? null,
      git_repo_name: (snapshot.git_repo_name as string) ?? null,
      git_branch: (snapshot.git_branch as string) ?? null,
      model: snapshot.model as string,
      provider: snapshot.provider as string,
      message_count_user: promptMetric.message_count_user,
      message_count_assistant: promptMetric.message_count_assistant,
      message_count_total: promptMetric.message_count_total,
      tool_call_count: toolMetric.tool_call_count,
      tokens: tokenMetric,
      parent_session_id: (snapshot.parent_session_id as string) ?? null,
      agent_name: (snapshot.agent_name as string) ?? null,
      subagent_calls: subagentMetric.subagent_calls,
      background_agents: subagentMetric.background_agents,
      mcp_calls: mcpMetric.mcp_calls,
      plan_mode_entries: planMetric.plan_mode_entries,
      plan_mode_exits: planMetric.plan_mode_exits,
      tool_calls: toolMetric.tool_calls,
      subagents: (snapshot.subagents as SessionMeta["subagents"]) ?? [],
      skills_used: skillMetric.skills_used,
      mcp_servers: Object.fromEntries(
        mcpMetric.servers.map((server) => [
          server.server_name,
          {
            count: server.invocation_count,
            uri: server.uri,
            primitives: server.primitives.map((p) => ({
              name: p.name,
              type: p.primitive_type,
              count: p.invocation_count,
            })),
          },
        ]),
      ),
      daily: dailyMetric.daily,
      cost_usd: costMetric.cost_usd,
      intervention_rate: promptMetric.intervention_rate,
      data_completeness: (snapshot.data_completeness as string) ?? "full",
      is_pruned: Boolean(snapshot.is_pruned ?? false),
      started_at: snapshot.started_at as string,
      ended_at: (snapshot.ended_at as string) ?? null,
      duration_seconds: (snapshot.duration_seconds as number) ?? null,
      total_exec_seconds: (snapshot.total_exec_seconds as number) ?? null,
      mean_turn_seconds: (snapshot.mean_turn_seconds as number) ?? null,
      median_turn_seconds: (snapshot.median_turn_seconds as number) ?? null,
      time_spans: (snapshot.time_spans as SessionMeta["time_spans"]) ?? [],
    };
  }
}
