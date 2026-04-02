import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

import { machineId, utcnowIso } from "./helpers.js";
import {
  getClaudeHistoryPaths,
  getCodexHistoryPaths,
  getCursorHistoryPaths,
  getGeminiHistoryPaths,
  getOpenCodeHistoryPaths,
} from "./history-paths.js";
import {
  Harness,
  createUploadBatch,
  type HarnessMeta,
  type SessionMeta,
  type UploadBatch,
  type Primitive,
  type PluginEntry,
  type InventoryBlob,
  type PrimitiveScope,
} from "./models.js";
import { PARSERS } from "./parsers/index.js";
import { VERSION } from "./version.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

function getInstalledCliVersion(binary: string): string | null {
  try {
    const stdout = execSync(`${binary} --version`, {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return stdout || null;
  } catch {
    return null;
  }
}

const HARNESS_BINARIES: Partial<Record<Harness, string>> = {
  [Harness.CLAUDE]: "claude",
  [Harness.GEMINI]: "gemini",
  [Harness.CODEX]: "codex",
  [Harness.AGENT]: "agent",
};

const HARNESS_PROVIDERS: Record<Harness, string> = {
  [Harness.CLAUDE]: "anthropic",
  [Harness.GEMINI]: "google",
  [Harness.CODEX]: "openai",
  [Harness.AGENT]: "cursor",
  [Harness.OPENCODE]: "opencode",
};

function getHarnessVersionFromHistory(harness: Harness): string | null {
  try {
    if (harness === Harness.CODEX) {
      const dbPath = getCodexHistoryPaths().stateDbPath;
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare(
            "SELECT cli_version FROM threads ORDER BY created_at DESC LIMIT 1",
          )
          .get() as { cli_version: string | null } | undefined;
        db.close();
        if (row?.cli_version) return row.cli_version;
      }
    } else if (harness === Harness.OPENCODE) {
      const dbPath = getOpenCodeHistoryPaths().dbPath;
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare(
            "SELECT version FROM session ORDER BY time_created DESC LIMIT 1",
          )
          .get() as { version: string | null } | undefined;
        db.close();
        if (row?.version) return row.version;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getSessionDateRange(
  harness: Harness,
): [string | null, string | null] {
  const timestamps: number[] = [];
  const datesStr: string[] = [];

  try {
    if (harness === Harness.CLAUDE) {
      const sessionsDir = getClaudeHistoryPaths().appSessionsDir;
      if (existsSync(sessionsDir)) {
        for (const file of readdirRecursive(sessionsDir, ".json")) {
          try {
            const d = JSON.parse(readFileSync(file, "utf-8"));
            for (const key of ["createdAt", "lastActivityAt"]) {
              const ts = d[key];
              if (ts && typeof ts === "number") {
                timestamps.push(Math.floor(ts));
              }
            }
          } catch {
            // skip
          }
        }
      }
    } else if (harness === Harness.GEMINI) {
      const tmpDir = getGeminiHistoryPaths().tmpDir;
      if (existsSync(tmpDir)) {
        for (const file of readdirRecursive(tmpDir, ".json").filter(f => f.includes("/chats/"))) {
          try {
            const d = JSON.parse(readFileSync(file, "utf-8"));
            for (const key of ["startTime", "lastUpdated"]) {
              const ts = d[key];
              if (ts && typeof ts === "string" && ts.length >= 10) {
                datesStr.push(ts.slice(0, 10));
              }
            }
          } catch {
            // skip
          }
        }
      }
    } else if (harness === Harness.AGENT) {
      const chatsDir = getCursorHistoryPaths().chatsDir;
      if (existsSync(chatsDir)) {
        for (const file of readdirRecursive(chatsDir, "store.db")) {
          try {
            const db = new Database(file, { readonly: true });
            const row = db
              .prepare("SELECT value FROM meta LIMIT 1")
              .get() as { value: string } | undefined;
            if (row?.value) {
              const meta = JSON.parse(Buffer.from(row.value, "hex").toString());
              const ts = meta.createdAt;
              if (ts && typeof ts === "number") {
                timestamps.push(Math.floor(ts));
              }
            }
            db.close();
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Convert timestamps to date strings
  for (const ts of timestamps) {
    const d = new Date(ts);
    datesStr.push(d.toISOString().slice(0, 10));
  }

  if (datesStr.length === 0) {
    return [null, null];
  }

  datesStr.sort();
  return [datesStr[0], datesStr[datesStr.length - 1]];
}

function getVersionRangeFromHistory(harness: Harness): string | null {
  let versions: string[] = [];
  try {
    if (harness === Harness.CODEX) {
      const dbPath = getCodexHistoryPaths().stateDbPath;
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const rows = db
          .prepare(
            "SELECT DISTINCT cli_version FROM threads WHERE cli_version IS NOT NULL",
          )
          .all() as { cli_version: string }[];
        versions = [
          ...new Set(rows.map((r) => r.cli_version).filter(Boolean)),
        ];
        db.close();
      }
    } else if (harness === Harness.OPENCODE) {
      const dbPath = getOpenCodeHistoryPaths().dbPath;
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const rows = db
          .prepare(
            "SELECT DISTINCT version FROM session WHERE version IS NOT NULL",
          )
          .all() as { version: string }[];
        versions = [...new Set(rows.map((r) => r.version).filter(Boolean))];
        db.close();
      }
    }
  } catch {
    // ignore
  }

  if (versions.length === 0) return null;
  if (versions.length === 1) return versions[0];

  // Sort by semver-ish
  versions.sort((a, b) => {
    const pa = a.split(".").map((p) => {
      const n = Number(p);
      return Number.isNaN(n) ? p : n;
    });
    const pb = b.split(".").map((p) => {
      const n = Number(p);
      return Number.isNaN(n) ? p : n;
    });
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (typeof va === "number" && typeof vb === "number") {
        if (va !== vb) return va - vb;
      } else {
        const cmp = String(va).localeCompare(String(vb));
        if (cmp !== 0) return cmp;
      }
    }
    return 0;
  });

  return `${versions[0]}..${versions[versions.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Inventory collection
// ---------------------------------------------------------------------------

// Canonical native tool descriptions per harness
const CLAUDE_TOOLS: Record<string, string> = {
  Read: "Read file contents",
  Write: "Write/create files",
  Edit: "Edit with string replacement",
  Bash: "Execute shell commands",
  Glob: "Find files by pattern",
  Grep: "Search file contents",
  WebSearch: "Search the web",
  WebFetch: "Fetch and process web content",
  Agent: "Spawn subagent for complex tasks",
  Skill: "Load specialized skill instructions",
  ToolSearch: "Search for deferred tools",
  EnterPlanMode: "Enter analysis-only mode",
  ExitPlanMode: "Exit plan mode",
  TaskCreate: "Create a task",
  TaskUpdate: "Update task status",
  TaskGet: "Get task details",
  TaskList: "List all tasks",
  NotebookEdit: "Edit Jupyter notebooks",
  LSP: "Language Server Protocol queries",
  AskUserQuestion: "Ask the user a question",
};

const CLAUDE_AGENTS: Record<string, string> = {
  "general-purpose": "General-purpose agent for multi-step tasks",
  Explore: "Fast agent for codebase exploration and search",
  Plan: "Software architect agent for designing implementation plans",
  "claude-code-guide": "Agent for answering questions about Claude Code features",
  "statusline-setup": "Agent for configuring Claude Code status line settings",
};

const GEMINI_TOOLS: Record<string, string> = {
  glob: "Find files by pattern",
  grep_search: "Search file contents",
  list_directory: "List directory",
  read_file: "Read file contents",
  run_shell_command: "Execute shell commands",
  write_file: "Write files",
  replace: "Replace text in files",
  google_web_search: "Search the web",
  web_fetch: "Fetch web content",
  read_many_files: "Read multiple files",
  memory: "Store/recall facts",
  activate_skill: "Load a skill",
  ask_user: "Ask the user",
  enter_plan_mode: "Enter plan mode",
  exit_plan_mode: "Exit plan mode",
  write_todos: "Write todo list",
  get_internal_docs: "Get internal docs",
  update_topic: "Update conversation topic",
  tracker_create_task: "Create tracker task",
  tracker_update_task: "Update tracker task",
  tracker_get_task: "Get tracker task",
  tracker_list_tasks: "List tracker tasks",
  tracker_add_dependency: "Add task dependency",
  tracker_visualize: "Visualize tasks",
};

const GEMINI_AGENTS: Record<string, string> = {
  generalist: "General-purpose subagent for diverse tasks",
  cli_help: "CLI documentation and help agent",
  codebase_investigator: "Deep codebase analysis agent",
};

const CODEX_TOOLS: Record<string, string> = {
  exec_command: "Execute commands",
  shell: "Shell access",
  write_stdin: "Write to stdin",
  update_plan: "Update execution plan",
  tool_suggest: "Suggest tools",
  list_mcp_resources: "List MCP resources",
  list_mcp_resource_templates: "List MCP templates",
};

const CODEX_AGENTS: Record<string, string> = {
  spawn_agent: "Spawn a collaborative subagent",
  wait_agent: "Wait for subagent completion",
};

const OPENCODE_TOOLS: Record<string, string> = {
  bash: "Execute shell commands",
  edit: "Edit files",
  glob: "Find files",
  read: "Read files",
  write: "Write files",
  question: "Ask the user",
  todowrite: "Write todo items",
  skill: "Load a skill",
  task: "Spawn a subagent task",
};

const CURSOR_TOOLS: Record<string, string> = {
  Read: "Read files",
  Write: "Write files",
  Edit: "Edit files",
  Shell: "Execute commands",
  Glob: "Find files",
  Grep: "Search contents",
  LS: "List directory",
  StrReplace: "String replacement",
  ReadLints: "Read lint results",
  WebSearch: "Search the web",
  Task: "Create task",
};

function readSkillMetadata(
  skillDir: string,
): Record<string, string | undefined> {
  const meta: Record<string, string | undefined> = {
    name: skillDir.split("/").pop() ?? "",
  };
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return meta;

  try {
    const lines = readFileSync(skillMd, "utf-8").split("\n").slice(0, 30);
    let inFront = false;
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped === "---") {
        if (inFront) break;
        inFront = true;
        continue;
      }
      if (inFront && stripped.includes(":")) {
        const colonIdx = stripped.indexOf(":");
        const key = stripped.slice(0, colonIdx).trim().toLowerCase();
        let val = stripped
          .slice(colonIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (key === "description" && val && !val.endsWith("|")) {
          meta.description = val.slice(0, 200);
        } else if (key === "version" && val) {
          meta.version = val;
        } else if (key === "author" && val) {
          meta.author = val;
        }
      }
    }
    // Install date from directory creation time
    try {
      const st = statSync(skillDir);
      if (st.birthtimeMs > 0) {
        meta.installed_at = new Date(st.birthtimeMs)
          .toISOString()
          .slice(0, 10);
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
  return meta;
}

function readPluginMetadata(
  pluginName: string,
  marketplaceSlug = "claude-plugins-official",
): Record<string, string | undefined> {
  const meta: Record<string, string | undefined> = {
    name: pluginName,
    marketplace: marketplaceSlug,
  };
  const cacheDir = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    marketplaceSlug,
    pluginName,
  );
  if (!existsSync(cacheDir)) return meta;

  try {
    const versionDirs = readdirSync(cacheDir).sort().reverse();
    for (const vd of versionDirs) {
      for (const pluginDirName of [".claude-plugin", ".cursor-plugin"]) {
        const pj = join(cacheDir, vd, pluginDirName, "plugin.json");
        if (existsSync(pj)) {
          try {
            const data = JSON.parse(readFileSync(pj, "utf-8"));
            if (data.description)
              meta.description = String(data.description).slice(0, 200);
            if (data.version) meta.version = data.version;
            if (data.homepage) meta.url = data.homepage;
            else if (data.repository) meta.url = data.repository;
            const author = data.author;
            if (typeof author === "object" && author?.name) {
              meta.author = author.name;
            } else if (typeof author === "string") {
              meta.author = author;
            }
          } catch {
            // ignore
          }
          return meta;
        }
      }
    }
  } catch {
    // ignore
  }
  return meta;
}

/**
 * Parse Codex config.toml for installed plugins.
 * Format: [plugins."name@marketplace"] with enabled = true/false
 */
function parseTomlPlugins(content: string): Array<{name: string, marketplace: string, enabled: boolean}> {
  const plugins: Array<{name: string, marketplace: string, enabled: boolean}> = [];
  const pluginRegex = /\[plugins\."([^@]+)@([^"]+)"\]/g;
  let match;
  while ((match = pluginRegex.exec(content)) !== null) {
    const name = match[1];
    const marketplace = match[2];
    // Look for enabled = true/false after the section header
    const afterSection = content.slice(match.index + match[0].length);
    const enabledMatch = afterSection.match(/^\s*enabled\s*=\s*(true|false)/m);
    plugins.push({ name, marketplace, enabled: enabledMatch?.[1] === 'true' });
  }
  return plugins;
}

/**
 * Discover skills provided by a Codex plugin from its cache directory.
 * Scans ~/.codex/plugins/cache/{marketplace}/{plugin}/{hash}/skills/
 */
function collectCodexPluginSkills(
  pluginName: string,
  marketplace: string,
  codexHome: string,
): Array<{ name: string; description?: string; version?: string; author?: string }> {
  const skills: Array<{ name: string; description?: string; version?: string; author?: string }> = [];
  const cacheDir = join(codexHome, "plugins", "cache", marketplace, pluginName);
  if (!existsSync(cacheDir)) return skills;

  try {
    const hashDirs = readdirSync(cacheDir).sort().reverse();
    for (const hd of hashDirs) {
      const skillsDir = join(cacheDir, hd, "skills");
      if (!existsSync(skillsDir)) continue;
      for (const skillName of readdirSync(skillsDir).sort()) {
        const skillPath = join(skillsDir, skillName);
        if (!statSync(skillPath).isDirectory()) continue;
        const meta = readSkillMetadata(skillPath);
        skills.push({
          name: meta.name || skillName,
          description: meta.description,
          version: meta.version,
          author: meta.author,
        });
      }
      break; // only latest hash
    }
  } catch { /* ignore */ }
  return skills;
}

/**
 * Discover MCP-like app connectors from a Codex plugin cache.
 * Looks for .app.json files in ~/.codex/plugins/cache/{marketplace}/{plugin}/{hash}/
 */
function collectCodexPluginApps(
  pluginName: string,
  marketplace: string,
  codexHome: string,
): string[] {
  const apps: string[] = [];
  const cacheDir = join(codexHome, "plugins", "cache", marketplace, pluginName);
  if (!existsSync(cacheDir)) return apps;

  try {
    const hashDirs = readdirSync(cacheDir).sort().reverse();
    for (const hd of hashDirs) {
      const appJsonPath = join(cacheDir, hd, ".app.json");
      if (existsSync(appJsonPath)) {
        try {
          const data = JSON.parse(readFileSync(appJsonPath, "utf-8"));
          const appName = data.name || pluginName;
          apps.push(appName);
        } catch {
          apps.push(pluginName);
        }
      }
      break; // only latest hash
    }
  } catch { /* ignore */ }
  return apps;
}

/**
 * Discover user commands from ~/.claude/commands/
 */
function collectUserCommands(): Record<string, string | undefined>[] {
  const commands: Record<string, string | undefined>[] = [];
  const commandsDir = join(homedir(), ".claude", "commands");
  if (!existsSync(commandsDir)) return commands;
  try {
    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");
      commands.push({ name, source: "command" });
    }
  } catch { /* ignore */ }
  return commands;
}

/**
 * Discover project-scoped skills from {projectDir}/.claude/skills/
 */
export function collectProjectSkills(projectDir: string): Record<string, string | undefined>[] {
  const skills: Record<string, string | undefined>[] = [];
  const skillsDir = join(projectDir, ".claude", "skills");
  if (!existsSync(skillsDir)) return skills;
  try {
    for (const d of readdirSync(skillsDir).sort()) {
      const fullPath = join(skillsDir, d);
      if (statSync(fullPath).isDirectory()) {
        const meta = readSkillMetadata(fullPath);
        meta.scope = "project";
        skills.push(meta);
      }
    }
  } catch { /* ignore */ }
  return skills;
}

function sortedEntries(
  obj: Record<string, string>,
): Array<{ name: string; description: string }> {
  return Object.keys(obj)
    .sort()
    .map((k) => ({ name: k, description: obj[k] }));
}

type InventoryItem = Record<string, string | undefined>;

/**
 * Collect user-level (harness-wide) inventory in the new Primitive/PluginEntry format.
 */
export function collectHarnessInventory(
  harness: Harness,
): InventoryBlob {
  const primitives: Primitive[] = [];
  const plugins: PluginEntry[] = [];

  try {
    if (harness === Harness.CLAUDE) {
      // Native tools → built-in standalone
      for (const [name, description] of Object.entries(CLAUDE_TOOLS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'tool', name, scope: 'built-in', source: 'standalone', description });
      }

      const claudeHome = getClaudeHistoryPaths().home;

      // Built-in agents → built-in standalone
      for (const [name, description] of Object.entries(CLAUDE_AGENTS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'agent', name, scope: 'built-in', source: 'standalone', description });
      }

      // User agents from ~/.claude/agents/
      const agentsDir = join(claudeHome, "agents");
      if (existsSync(agentsDir)) {
        for (const file of readdirSync(agentsDir).sort()) {
          if (!file.endsWith(".md")) continue;
          const name = file.replace(/\.md$/, "");
          primitives.push({ type: 'agent', name, scope: 'user', source: 'standalone' });
        }
      }

      // Plugin agents from installed plugin caches
      const pluginCacheDir = join(claudeHome, "plugins", "cache");
      if (existsSync(pluginCacheDir)) {
        const seenAgents = new Set<string>();
        try {
          for (const marketplace of readdirSync(pluginCacheDir)) {
            const mDir = join(pluginCacheDir, marketplace);
            if (!statSync(mDir).isDirectory()) continue;
            for (const pluginName of readdirSync(mDir)) {
              const pDir = join(mDir, pluginName);
              if (!statSync(pDir).isDirectory()) continue;
              const versions = readdirSync(pDir).sort().reverse();
              for (const ver of versions) {
                const agDir = join(pDir, ver, "agents");
                if (!existsSync(agDir)) continue;
                for (const agentFile of readdirSync(agDir)) {
                  if (!agentFile.endsWith(".md")) continue;
                  const agentName = agentFile.replace(/\.md$/, "");
                  if (seenAgents.has(agentName)) continue;
                  seenAgents.add(agentName);
                  primitives.push({
                    type: 'agent', name: agentName, scope: 'user', source: 'plugin',
                    plugin: `${pluginName}@${marketplace}`,
                  });
                  // Add to the parent plugin's provides list
                  const parentPlugin = plugins.find(p => p.name === pluginName && p.marketplace === marketplace);
                  if (parentPlugin && !parentPlugin.provides_mcp_servers.includes(agentName)) {
                    // No provides_agents field yet, but we track via primitives
                  }
                }
                break; // only latest version
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Built-in MCP servers
      for (const name of ['claude-in-chrome', 'computer-use']) {
        primitives.push({ type: 'mcp_server', name, scope: 'built-in', source: 'standalone' });
      }

      // 1. User skills from ~/.claude/skills/
      const skillsDir = join(claudeHome, "skills");
      if (existsSync(skillsDir)) {
        for (const d of readdirSync(skillsDir).sort()) {
          const fullPath = join(skillsDir, d);
          if (statSync(fullPath).isDirectory()) {
            const meta = readSkillMetadata(fullPath);
            primitives.push({
              type: 'skill',
              name: meta.name || d,
              scope: 'user',
              source: 'standalone',
              description: meta.description,
              version: meta.version,
              author: meta.author,
            });
          }
        }
      }

      // 2. User commands from ~/.claude/commands/
      for (const cmd of collectUserCommands()) {
        primitives.push({
          type: 'command',
          name: cmd.name || '',
          scope: 'user',
          source: 'standalone',
        });
      }

      // 3. Installed plugins and their provided skills
      const installedFile = join(claudeHome, "plugins", "installed_plugins.json");
      if (existsSync(installedFile)) {
        try {
          const data = JSON.parse(readFileSync(installedFile, "utf-8"));
          const installedPlugins = data.plugins ?? {};
          for (const [pid, _entries] of Object.entries(installedPlugins)) {
            const base = pid.split("@")[0];
            const marketplace = pid.split("@")[1] || "unknown";
            const meta = readPluginMetadata(base, marketplace);
            const pluginTag = `${base}@${marketplace}`;

            // Discover skills this plugin provides
            const providedSkills = collectPluginSkillsForPlugin(base, marketplace);
            const providedMcpServers: string[] = []; // future: discover MCP servers from plugins

            // Determine plugin scope from installed_plugins.json
            const entryData = _entries as Record<string, unknown>;
            const pluginScope: PrimitiveScope =
              entryData?.scope === "user" ? "user" : "user"; // installed plugins are user-scoped

            plugins.push({
              name: base,
              marketplace,
              scope: pluginScope,
              enabled: true,
              version: meta.version,
              provides_skills: providedSkills.map(s => s.name),
              provides_mcp_servers: providedMcpServers,
            });

            // Add plugin-provided skills as primitives
            for (const skill of providedSkills) {
              primitives.push({
                type: 'skill',
                name: skill.name,
                scope: pluginScope,
                source: 'plugin',
                plugin: pluginTag,
                marketplace,
                description: skill.description,
                version: skill.version,
                author: skill.author,
              });
            }
          }
        } catch { /* ignore */ }
      }
    } else if (harness === Harness.GEMINI) {
      for (const [name, description] of Object.entries(GEMINI_TOOLS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'tool', name, scope: 'built-in', source: 'standalone', description });
      }
      for (const [name, description] of Object.entries(GEMINI_AGENTS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'agent', name, scope: 'built-in', source: 'standalone', description });
      }
      const geminiPaths = getGeminiHistoryPaths();
      const seenSkills = new Set<string>();
      for (const sDir of [geminiPaths.skillsDir, geminiPaths.agentsSkillsDir]) {
        if (existsSync(sDir)) {
          for (const d of readdirSync(sDir).sort()) {
            const fullPath = join(sDir, d);
            if (statSync(fullPath).isDirectory() && !seenSkills.has(d)) {
              const meta = readSkillMetadata(fullPath);
              primitives.push({
                type: 'skill',
                name: meta.name || d,
                scope: 'user',
                source: 'standalone',
                description: meta.description,
                version: meta.version,
                author: meta.author,
              });
              seenSkills.add(d);
            }
          }
        }
      }
    } else if (harness === Harness.CODEX) {
      // Built-in tools
      for (const [name, description] of Object.entries(CODEX_TOOLS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'tool', name, scope: 'built-in', source: 'standalone', description });
      }
      // Built-in agent spawning tools
      for (const [name, description] of Object.entries(CODEX_AGENTS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'agent', name, scope: 'built-in', source: 'standalone', description });
      }
      // Built-in agent types
      for (const agentType of ['default', 'explorer', 'worker']) {
        primitives.push({ type: 'agent', name: agentType, scope: 'built-in', source: 'standalone', description: `Built-in ${agentType} agent type` });
      }
      // Built-in MCP server
      primitives.push({ type: 'mcp_server', name: 'codex_apps', scope: 'built-in', source: 'standalone' });

      // 1. Standalone skills from ~/.agents/skills/ (shared with Claude)
      const agentsSkillsDir = join(homedir(), ".agents", "skills");
      if (existsSync(agentsSkillsDir)) {
        for (const d of readdirSync(agentsSkillsDir).sort()) {
          const fullPath = join(agentsSkillsDir, d);
          if (statSync(fullPath).isDirectory()) {
            const meta = readSkillMetadata(fullPath);
            primitives.push({
              type: 'skill',
              name: meta.name || d,
              scope: 'user',
              source: 'standalone',
              description: meta.description,
              version: meta.version,
              author: meta.author,
            });
          }
        }
      }

      // 2. Installed plugins from config.toml + plugin cache
      const codexPaths = getCodexHistoryPaths();
      if (existsSync(codexPaths.configPath)) {
        try {
          const tomlContent = readFileSync(codexPaths.configPath, "utf-8");
          const parsedPlugins = parseTomlPlugins(tomlContent);
          for (const pp of parsedPlugins) {
            const pluginTag = `${pp.name}@${pp.marketplace}`;

            // Discover skills from plugin cache
            const providedSkills = collectCodexPluginSkills(pp.name, pp.marketplace, codexPaths.home);
            // Discover app connectors (MCP-like) from plugin cache
            const providedMcpServers = collectCodexPluginApps(pp.name, pp.marketplace, codexPaths.home);

            plugins.push({
              name: pp.name,
              marketplace: pp.marketplace,
              scope: 'user',
              enabled: pp.enabled,
              provides_skills: providedSkills.map(s => s.name),
              provides_mcp_servers: providedMcpServers,
            });

            // Add plugin-provided skills as primitives
            for (const skill of providedSkills) {
              primitives.push({
                type: 'skill',
                name: skill.name,
                scope: 'user',
                source: 'plugin',
                plugin: pluginTag,
                marketplace: pp.marketplace,
                description: skill.description,
                version: skill.version,
                author: skill.author,
              });
            }

            // Add plugin app connectors as MCP server primitives
            for (const appName of providedMcpServers) {
              primitives.push({
                type: 'mcp_server',
                name: appName,
                scope: 'user',
                source: 'plugin',
                plugin: pluginTag,
                marketplace: pp.marketplace,
              });
            }
          }
        } catch { /* ignore */ }
      }
    } else if (harness === Harness.OPENCODE) {
      for (const [name, description] of Object.entries(OPENCODE_TOOLS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'tool', name, scope: 'built-in', source: 'standalone', description });
      }
      // OpenCode can use Claude skills
      const skillsDir = join(homedir(), ".claude", "skills");
      if (existsSync(skillsDir)) {
        for (const d of readdirSync(skillsDir).sort()) {
          const fullPath = join(skillsDir, d);
          if (statSync(fullPath).isDirectory()) {
            const meta = readSkillMetadata(fullPath);
            primitives.push({
              type: 'skill',
              name: meta.name || d,
              scope: 'user',
              source: 'standalone',
              description: meta.description,
              version: meta.version,
              author: meta.author,
            });
          }
        }
      }
    } else if (harness === Harness.AGENT) {
      for (const [name, description] of Object.entries(CURSOR_TOOLS).sort(([a], [b]) => a.localeCompare(b))) {
        primitives.push({ type: 'tool', name, scope: 'built-in', source: 'standalone', description });
      }
    }
  } catch {
    // ignore
  }

  return { primitives, plugins };
}

/**
 * Discover skills provided by a specific installed plugin.
 * Scans ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/skills/
 */
function collectPluginSkillsForPlugin(
  pluginName: string,
  marketplace: string,
): Array<{ name: string; description?: string; version?: string; author?: string }> {
  const skills: Array<{ name: string; description?: string; version?: string; author?: string }> = [];
  const cacheDir = join(homedir(), ".claude", "plugins", "cache", marketplace, pluginName);
  if (!existsSync(cacheDir)) return skills;

  try {
    const versions = readdirSync(cacheDir).sort().reverse();
    for (const ver of versions) {
      const skillsDir = join(cacheDir, ver, "skills");
      if (!existsSync(skillsDir)) continue;
      for (const skillName of readdirSync(skillsDir)) {
        const skillPath = join(skillsDir, skillName);
        if (!statSync(skillPath).isDirectory()) continue;
        const meta = readSkillMetadata(skillPath);
        skills.push({
          name: meta.name || skillName,
          description: meta.description,
          version: meta.version,
          author: meta.author,
        });
      }
      break; // only latest version
    }
  } catch { /* ignore */ }
  return skills;
}

/**
 * Collect project-scoped inventory for a harness.
 * Currently only Claude and Gemini have project-level config files.
 */
export function collectProjectInventory(
  harness: Harness,
  projectDir: string,
): InventoryBlob {
  const primitives: Primitive[] = [];
  const pluginEntries: PluginEntry[] = [];

  try {
    if (harness === Harness.CLAUDE) {
      // Track which plugin IDs come from settings.json vs settings.local.json
      const projectPluginIds = new Set<string>();
      const localPluginIds = new Set<string>();

      // Project-scoped plugins from .claude/settings.json
      const settingsFile = join(projectDir, ".claude", "settings.json");
      if (existsSync(settingsFile)) {
        try {
          const data = JSON.parse(readFileSync(settingsFile, "utf-8"));
          for (const pid of Object.keys(data.enabledPlugins ?? {})) {
            projectPluginIds.add(pid);
          }
        } catch { /* ignore */ }
      }

      // Local overrides from .claude/settings.local.json
      const localSettingsFile = join(projectDir, ".claude", "settings.local.json");
      if (existsSync(localSettingsFile)) {
        try {
          const data = JSON.parse(readFileSync(localSettingsFile, "utf-8"));
          for (const pid of Object.keys(data.enabledPlugins ?? {})) {
            localPluginIds.add(pid);
          }
        } catch { /* ignore */ }
      }

      // Merge: local takes precedence over project
      const allPluginIds = new Set([...projectPluginIds, ...localPluginIds]);
      for (const pid of allPluginIds) {
        const base = pid.split("@")[0];
        const marketplace = pid.split("@")[1] || "claude-plugins-official";
        if (!base) continue;

        // Scope: local if in settings.local.json, otherwise project
        const scope: PrimitiveScope = localPluginIds.has(pid) ? 'local' : 'project';
        const meta = readPluginMetadata(base, marketplace);
        const providedSkills = collectPluginSkillsForPlugin(base, marketplace);

        pluginEntries.push({
          name: base,
          marketplace,
          scope,
          enabled: true,
          version: meta.version,
          provides_skills: providedSkills.map(s => s.name),
          provides_mcp_servers: [],
        });

        // Add plugin-provided skills as primitives
        const pluginTag = `${base}@${marketplace}`;
        for (const skill of providedSkills) {
          primitives.push({
            type: 'skill',
            name: skill.name,
            scope,
            source: 'plugin',
            plugin: pluginTag,
            marketplace,
            description: skill.description,
            version: skill.version,
            author: skill.author,
          });
        }
      }

      // Project skills from {projectDir}/.claude/skills/
      for (const skill of collectProjectSkills(projectDir)) {
        primitives.push({
          type: 'skill',
          name: skill.name || '',
          scope: 'project',
          source: 'standalone',
          description: skill.description,
          version: skill.version,
          author: skill.author,
        });
      }

      // MCP servers from .mcp.json
      const mcpFile = join(projectDir, ".mcp.json");
      if (existsSync(mcpFile)) {
        try {
          const data = JSON.parse(readFileSync(mcpFile, "utf-8"));
          const servers = data.mcpServers ?? data.servers ?? data;
          if (typeof servers === "object" && servers !== null) {
            for (const serverName of Object.keys(servers)) {
              primitives.push({
                type: 'mcp_server',
                name: serverName,
                scope: 'project',
                source: 'standalone',
              });
            }
          }
        } catch { /* ignore */ }
      }
    } else if (harness === Harness.GEMINI) {
      // Gemini project settings
      const settingsFile = join(projectDir, ".gemini", "settings.json");
      if (existsSync(settingsFile)) {
        try {
          const data = JSON.parse(readFileSync(settingsFile, "utf-8"));
          const extensions = data.extensions ?? {};
          for (const [extName, _val] of Object.entries(extensions)) {
            pluginEntries.push({
              name: extName,
              marketplace: "gemini",
              scope: 'project',
              enabled: true,
              provides_skills: [],
              provides_mcp_servers: [],
            });
          }
        } catch { /* ignore */ }
      }
    }
    // Codex, Cursor, OpenCode: no project-level config — return empty
  } catch {
    // ignore
  }

  return { primitives, plugins: pluginEntries };
}

// ---------------------------------------------------------------------------
// Harness meta
// ---------------------------------------------------------------------------

function collectHarnessMeta(harness: Harness): HarnessMeta {
  const osName = process.platform;
  const osArch = process.arch;
  const shell =
    (process.env.SHELL ?? "").split("/").pop() || "unknown";
  const provider = HARNESS_PROVIDERS[harness];
  let source = "cli";
  let defaultModel: string | null = null;
  let pluginVersion: string | null = null;

  // 1. Version range from history (preferred)
  let cliVersion = getVersionRangeFromHistory(harness);

  // 2. Fallback: session date range as version proxy
  if (!cliVersion) {
    const [earliest, latest] = getSessionDateRange(harness);
    if (earliest && latest && earliest !== latest) {
      cliVersion = `~${earliest}..${latest}`;
    } else if (earliest) {
      cliVersion = `~${earliest}`;
    } else {
      cliVersion = "unknown";
    }
  }

  // 3. Harness-specific extras
  if (harness === Harness.CODEX) {
    try {
      const dbPath = getCodexHistoryPaths().stateDbPath;
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare(
            "SELECT model, source FROM threads ORDER BY created_at DESC LIMIT 1",
          )
          .get() as { model: string; source: string | null } | undefined;
        if (row) {
          defaultModel = row.model;
          source = row.source ?? "cli";
        }
        db.close();
      }
    } catch {
      // ignore
    }
  } else if (harness === Harness.OPENCODE) {
    try {
      const pkg = getOpenCodeHistoryPaths().packageJsonPath;
      if (existsSync(pkg)) {
        const data = JSON.parse(readFileSync(pkg, "utf-8"));
        pluginVersion =
          data.dependencies?.["@opencode-ai/plugin"] ?? null;
      }
    } catch {
      // ignore
    }
  }

  if (!cliVersion) {
    throw new Error(
      `Could not detect version for '${harness}' from history or installed binary.`,
    );
  }

  const inv = collectHarnessInventory(harness);

  // Derive legacy-format arrays from primitives for HarnessMeta compatibility
  const available_tools = inv.primitives
    .filter(p => p.type === 'tool')
    .map(p => ({ name: p.name, description: p.description }));
  const available_skills = inv.primitives
    .filter(p => p.type === 'skill')
    .map(p => ({ name: p.name, description: p.description, source: p.source, plugin: p.plugin }));
  const available_mcp_servers = inv.primitives
    .filter(p => p.type === 'mcp_server')
    .map(p => ({ name: p.name, description: p.description }));
  const available_agents = inv.primitives
    .filter(p => p.type === 'agent')
    .map(p => ({ name: p.name, description: p.description }));

  return {
    name: harness,
    cli_version: cliVersion,
    os_name: osName,
    os_arch: osArch,
    shell,
    source,
    default_model: defaultModel,
    provider,
    plugin_version: pluginVersion,
    config_hash: null,
    available_tools,
    available_skills,
    available_mcp_servers,
    available_agents,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively find files matching a suffix under a directory. */
function readdirRecursive(dir: string, suffix: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...readdirRecursive(full, suffix));
      } else if (entry.name.endsWith(suffix)) {
        results.push(full);
      }
    }
  } catch {
    // ignore permission errors etc.
  }
  return results;
}

// ---------------------------------------------------------------------------
// Build batch
// ---------------------------------------------------------------------------

export function buildBatch(
  harnesses: Harness[],
  since?: Date,
): UploadBatch | null {
  let allSessions: SessionMeta[] = [];

  // Resolve versions first so parsers can use them
  const harnessVersions: Partial<Record<Harness, string>> = {};
  const harnessMetasList: HarnessMeta[] = [];
  for (const harness of harnesses) {
    try {
      const meta = collectHarnessMeta(harness);
      harnessVersions[harness] = meta.cli_version;
      harnessMetasList.push(meta);
    } catch (e) {
      process.stderr.write(`  ${harness}: skipped (${e})\n`);
      continue;
    }
  }

  for (const harness of harnesses) {
    if (!(harness in harnessVersions)) continue;
    const parser = PARSERS[harness];
    if (parser) {
      const sessions = parser.parse(since);
      // Fill in harness_version for sessions that don't have it
      const patched: SessionMeta[] = [];
      for (const s of sessions) {
        if (!s.harness_version || !s.harness_version.trim()) {
          patched.push({
            ...s,
            harness_version: harnessVersions[harness]!,
          });
        } else {
          patched.push(s);
        }
      }
      allSessions.push(...patched);
      process.stderr.write(
        `  ${harness}: found ${patched.length} session(s)\n`,
      );
    }
  }

  if (allSessions.length === 0) return null;

  // Final validation
  for (const s of allSessions) {
    if (!s.harness_version) {
      throw new Error(
        `Session ${s.source_session_id} (${s.harness}) has no harness_version ` +
          `after resolution. This is a bug.`,
      );
    }
  }

  return createUploadBatch({
    id: randomUUID(),
    tool_version: VERSION,
    harnesses_scanned: harnesses,
    harness_meta: harnessMetasList,
    sessions: allSessions,
    machine_id: machineId(),
    created_at: utcnowIso(),
  });
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serializeBatch(batch: UploadBatch): Record<string, unknown> {
  // The TS interfaces are already plain objects; just return a deep copy
  return JSON.parse(JSON.stringify(batch));
}

// ---------------------------------------------------------------------------
// List projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
  name: string;
  harnesses: Harness[];
  sessionCount: number;
  completeness: string;
}

function summarizeCompleteness(levels: Set<string>): string {
  const order = ["full", "partial", "prompts_only"];
  const present = order.filter((l) => levels.has(l));
  return present.length > 0 ? present.join("+") : "unknown";
}

export function listProjects(batch: UploadBatch): ProjectRow[] {
  const projects = new Map<
    string,
    { harnesses: Set<Harness>; sessionCount: number; completeness: Set<string> }
  >();

  for (const session of batch.sessions) {
    if (!session.project_name) continue;
    let entry = projects.get(session.project_name);
    if (!entry) {
      entry = { harnesses: new Set(), sessionCount: 0, completeness: new Set() };
      projects.set(session.project_name, entry);
    }
    entry.harnesses.add(session.harness);
    entry.completeness.add(session.data_completeness || "full");
    entry.sessionCount += 1;
  }

  const rows: ProjectRow[] = [];
  for (const [name, entry] of [...projects.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    rows.push({
      name,
      harnesses: [...entry.harnesses].sort((a, b) => a.localeCompare(b)),
      sessionCount: entry.sessionCount,
      completeness: summarizeCompleteness(entry.completeness),
    });
  }
  return rows;
}

export function filterBatchProjects(
  batch: UploadBatch,
  selectedProjects: Set<string>,
): UploadBatch | null {
  const sessions = batch.sessions.filter(
    (s) => s.project_name != null && selectedProjects.has(s.project_name),
  );
  if (sessions.length === 0) return null;
  return createUploadBatch({
    id: randomUUID(),
    tool_version: batch.tool_version,
    harnesses_scanned: batch.harnesses_scanned,
    harness_meta: batch.harness_meta,
    sessions,
    machine_id: batch.machine_id,
    created_at: utcnowIso(),
  });
}

export function detectHarnessInstalled(harness: Harness): boolean {
  const home = homedir();
  try {
    switch (harness) {
      case Harness.CLAUDE:
        return commandExists("claude") || existsSync(join(home, ".claude"));
      case Harness.GEMINI:
        return commandExists("gemini") || existsSync(join(home, ".gemini"));
      case Harness.CODEX:
        return commandExists("codex") || existsSync(join(home, ".codex"));
      case Harness.AGENT:
        return commandExists("agent") || existsSync(join(home, ".cursor", "chats"));
      case Harness.OPENCODE:
        return commandExists("opencode") || existsSync(join(home, ".local", "share", "opencode", "opencode.db"));
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function commandExists(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
