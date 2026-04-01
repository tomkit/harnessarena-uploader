/**
 * Data models for the upload schema.
 *
 * Privacy contract: No field may contain message content, file contents,
 * code snippets, API keys, credentials, tool call arguments/results,
 * or full filesystem paths.
 */

export const HARNESSARENA_SCHEMA_VERSION = "0.1.0";

// --- Enums ---

export enum Harness {
  CLAUDE = "claude",
  GEMINI = "gemini",
  CODEX = "codex",
  AGENT = "agent",
  OPENCODE = "opencode",
}

export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  SYSTEM = "system",
  TOOL = "tool",
}

// --- Interfaces ---

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
}

export function createTokenUsage(partial?: Partial<TokenUsage>): TokenUsage {
  const t: TokenUsage = {
    input_tokens: partial?.input_tokens ?? 0,
    output_tokens: partial?.output_tokens ?? 0,
    cache_read_tokens: partial?.cache_read_tokens ?? 0,
    cache_write_tokens: partial?.cache_write_tokens ?? 0,
    total_tokens: partial?.total_tokens ?? 0,
  };
  for (const [k, v] of Object.entries(t)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`Token counts must be non-negative integers, got ${k}=${v}`);
    }
  }
  return t;
}

export interface ToolCallSummary {
  tool_name: string;
  invocation_count: number;
  category: string;
}

export interface MCPPrimitiveSummary {
  name: string;
  primitive_type: string;
  invocation_count: number;
}

export interface MCPServerSummary {
  server_name: string;
  invocation_count: number;
  uri: string | null;
  primitives: MCPPrimitiveSummary[];
}

export interface HarnessMeta {
  name: Harness;
  cli_version: string;
  os_name: string;
  os_arch: string;
  provider: string;
  shell: string;
  source: string;
  default_model: string | null;
  plugin_version: string | null;
  config_hash: string | null;
  available_tools: Record<string, string | undefined>[];
  available_skills: Record<string, string | undefined>[];
  available_mcp_servers: Record<string, string | undefined>[];
  available_agents: Record<string, string | undefined>[];
}

export interface SubagentMeta {
  ordinal: number;
  parent_ordinal: number | null;
  mode: string;
  subagent_type: string;
  nickname: string;
  description: string;
  depth: number;
  total_tokens: number;
  total_tool_calls: number;
}

export function createSubagentMeta(partial?: Partial<SubagentMeta>): SubagentMeta {
  return {
    ordinal: partial?.ordinal ?? 0,
    parent_ordinal: partial?.parent_ordinal ?? null,
    mode: partial?.mode ?? "foreground",
    subagent_type: partial?.subagent_type ?? "",
    nickname: partial?.nickname ?? "",
    description: partial?.description ?? "",
    depth: partial?.depth ?? 1,
    total_tokens: partial?.total_tokens ?? 0,
    total_tool_calls: partial?.total_tool_calls ?? 0,
  };
}

export interface SessionMeta {
  // Identity
  id: string;
  source_session_id: string;
  harness: Harness;
  harness_version: string | null;
  // Project
  project_name: string | null;
  git_repo_name: string | null;
  git_branch: string | null;
  // Model
  model: string;
  provider: string;
  // Counts
  message_count_user: number;
  message_count_assistant: number;
  message_count_total: number;
  tool_call_count: number;
  // Tokens
  tokens: TokenUsage;
  // Optional counts
  parent_session_id: string | null;
  agent_name: string | null;
  subagent_calls: number;
  background_agents: number;
  mcp_calls: number;
  plan_mode_entries: number;
  plan_mode_exits: number;
  // Breakdowns
  tool_calls: ToolCallSummary[];
  subagents: SubagentMeta[];
  skills_used: Record<string, Record<string, unknown>>;
  mcp_servers: Record<string, Record<string, unknown>>;
  daily: Record<string, unknown>[];
  // Cost
  cost_usd: number | null;
  // Data quality
  data_completeness: string;
  is_pruned: boolean;
  // Derived metrics
  intervention_rate: number | null;
  total_exec_seconds: number | null;
  mean_turn_seconds: number | null;
  median_turn_seconds: number | null;
  time_spans: Record<string, unknown>[];
  // Timing
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface UploadBatch {
  id: string;
  tool_version: string;
  harnesses_scanned: Harness[];
  harness_meta: HarnessMeta[];
  sessions: SessionMeta[];
  machine_id: string;
  created_at: string;
  schema_version: string;
  session_count: number;
  total_tokens: number;
}

export function createUploadBatch(
  params: Omit<UploadBatch, "schema_version" | "session_count" | "total_tokens">,
): UploadBatch {
  if (params.sessions.length === 0) {
    throw new Error("UploadBatch must contain at least one session");
  }
  return {
    ...params,
    schema_version: HARNESSARENA_SCHEMA_VERSION,
    session_count: params.sessions.length,
    total_tokens: params.sessions.reduce((sum, s) => sum + s.tokens.total_tokens, 0),
  };
}
