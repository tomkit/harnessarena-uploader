import type {
  MCPPrimitiveSummary,
  MCPServerSummary,
  TokenUsage,
  ToolCallSummary,
} from "./models.js";
import { createTokenUsage } from "./models.js";

// --- Metric result types ---

export interface PromptMetric {
  message_count_user: number;
  message_count_assistant: number;
  message_count_total: number;
  intervention_rate: number | null;
}

export interface SubagentMetric {
  subagent_calls: number;
  background_agents: number;
}

export interface MCPMetric {
  mcp_calls: number;
  servers: MCPServerSummary[];
}

export interface SkillMetric {
  skills_used: Record<string, Record<string, unknown>>;
}

export interface ToolMetric {
  tool_call_count: number;
  tool_calls: ToolCallSummary[];
}

export interface PlanMetric {
  plan_mode_entries: number;
  plan_mode_exits: number;
}

export interface DailyMetric {
  daily: Record<string, unknown>[];
}

export interface CostMetric {
  cost_usd: number | null;
}

// --- Strategy interfaces ---

export interface HarnessMetricStrategies {
  prompts: { parse(payload: Record<string, unknown>): PromptMetric };
  subagents: { parse(payload: Record<string, unknown>): SubagentMetric };
  mcp: { parse(payload: Record<string, unknown>): MCPMetric };
  skills: { parse(payload: Record<string, unknown>): SkillMetric };
  tools: { parse(payload: Record<string, unknown>): ToolMetric };
  tokens: { parse(payload: Record<string, unknown>): TokenUsage };
  plan: { parse(payload: Record<string, unknown>): PlanMetric };
  daily: { parse(payload: Record<string, unknown>): DailyMetric };
  cost: { parse(payload: Record<string, unknown>): CostMetric };
}

// --- Snapshot strategies (read from dict) ---

export function snapshotDefaults(): HarnessMetricStrategies {
  return {
    prompts: {
      parse(p) {
        const userCount = Number(p.message_count_user ?? 0);
        const toolCallCount = Number(p.tool_call_count ?? 0);
        return {
          message_count_user: userCount,
          message_count_assistant: Number(p.message_count_assistant ?? 0),
          message_count_total: Number(p.message_count_total ?? 0),
          intervention_rate: toolCallCount > 0 ? Math.round((userCount / toolCallCount) * 100) / 100 : null,
        };
      },
    },
    subagents: {
      parse(p) {
        return {
          subagent_calls: Number(p.subagent_calls ?? 0),
          background_agents: Number(p.background_agents ?? 0),
        };
      },
    },
    mcp: {
      parse(p) {
        const servers = p.mcp_servers;
        return {
          mcp_calls: Number(p.mcp_calls ?? 0),
          servers: mcpServerSummariesFromDict(
            typeof servers === "object" && servers !== null ? servers as Record<string, Record<string, unknown>> : {},
          ),
        };
      },
    },
    skills: {
      parse(p) {
        const skills = p.skills_used;
        return {
          skills_used: typeof skills === "object" && skills !== null ? skills as Record<string, Record<string, unknown>> : {},
        };
      },
    },
    tools: {
      parse(p) {
        let toolCalls = p.tool_calls;
        if (!Array.isArray(toolCalls)) toolCalls = [];
        return {
          tool_call_count: Number(p.tool_call_count ?? 0),
          tool_calls: toolCalls as ToolCallSummary[],
        };
      },
    },
    tokens: {
      parse(p) {
        const tokens = p.tokens;
        if (tokens && typeof tokens === "object" && "input_tokens" in (tokens as object)) {
          return tokens as TokenUsage;
        }
        return createTokenUsage();
      },
    },
    plan: {
      parse(p) {
        return {
          plan_mode_entries: Number(p.plan_mode_entries ?? 0),
          plan_mode_exits: Number(p.plan_mode_exits ?? 0),
        };
      },
    },
    daily: {
      parse(p) {
        const daily = p.daily;
        return { daily: Array.isArray(daily) ? daily : [] };
      },
    },
    cost: {
      parse(p) {
        const cost = p.cost_usd;
        return {
          cost_usd: typeof cost === "number" && cost >= 0 ? cost : null,
        };
      },
    },
  };
}

export function mcpServerSummariesFromDict(
  servers: Record<string, Record<string, unknown>>,
): MCPServerSummary[] {
  const summaries: MCPServerSummary[] = [];
  for (const serverName of Object.keys(servers).sort()) {
    const info = servers[serverName];
    const rawPrimitives = (info.primitives ?? {}) as Record<string, Record<string, unknown>>;
    const primitives: MCPPrimitiveSummary[] = Object.keys(rawPrimitives)
      .sort()
      .map((name) => ({
        name,
        primitive_type: String(rawPrimitives[name].primitive_type ?? "tool"),
        invocation_count: Number(rawPrimitives[name].invocation_count ?? 1),
      }));
    summaries.push({
      server_name: serverName,
      invocation_count: Number(info.invocation_count ?? 1),
      uri: (info.uri as string) ?? null,
      primitives,
    });
  }
  return summaries;
}
