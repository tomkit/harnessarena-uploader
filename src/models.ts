/**
 * Data models for the harness arena uploader.
 *
 * Privacy contract: No field may contain message content, file contents,
 * code snippets, API keys, credentials, tool call arguments/results,
 * or full filesystem paths.
 */

// --- Enums ---

export enum Harness {
  CLAUDE = "claude",
  GEMINI = "gemini",
  CODEX = "codex",
  AGENT = "agent",
  OPENCODE = "opencode",
}

// --- Inventory types ---

export type PrimitiveType = 'skill' | 'mcp_server' | 'agent' | 'command' | 'tool';
export type PrimitiveScope = 'local' | 'project' | 'user' | 'built-in';
export type PrimitiveSource = 'standalone' | 'plugin';

export interface Primitive {
  type: PrimitiveType;
  name: string;
  scope: PrimitiveScope;
  source: PrimitiveSource;
  plugin?: string;          // e.g. "superpowers@claude-plugins-official" — only if source=plugin
  marketplace?: string;     // e.g. "claude-plugins-official" — only if from marketplace
  description?: string;
  version?: string;
  author?: string;
}

export interface PluginEntry {
  name: string;             // e.g. "superpowers"
  marketplace: string;      // e.g. "claude-plugins-official", "claudeai"
  scope: PrimitiveScope;
  enabled: boolean;
  version?: string;
  provides_skills: string[];
  provides_mcp_servers: string[];
}

export interface InventoryBlob {
  primitives: Primitive[];
  plugins: PluginEntry[];
}

// --- Harness metadata ---

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
