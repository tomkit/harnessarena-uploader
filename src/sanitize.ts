/**
 * Sanitization layer — strips sensitive data from raw harness logs while
 * preserving the original schema shape and all metadata.
 *
 * What gets stripped:
 *   - Entire message content (user/assistant/system prompts and responses)
 *   - Tool call arguments (file paths, code, commands)
 *   - Tool call results (file contents, command output)
 *   - Thinking/reasoning text
 *   - Code diffs
 *   - Pasted contents
 *
 * What gets hashed (SHA-256, first 16 chars):
 *   - Absolute file paths in structural fields (cwd, directory)
 *   - Git origin URLs
 *
 * What passes through unchanged:
 *   - Timestamps, token counts, model names, provider names
 *   - Tool names, session IDs, message IDs, tool call IDs
 *   - Message roles, content block types, stop reasons
 *   - Git branch names, git SHAs
 *   - Agent metadata (nicknames, roles, modes, ordinals)
 *   - Cost values, version strings
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashPath(path: string | null | undefined): string {
  if (!path) return "";
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 16);
  const base = basename(path);
  return `h:${hash}/${base}`;
}

function isAbsolutePath(s: string): boolean {
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);
}

/** Deep clone and strip a value. Returns the sanitized copy. */
function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Claude Code — JSONL entries
// ---------------------------------------------------------------------------

/**
 * Sanitize a single Claude Code JSONL entry (one line parsed as JSON).
 * Strips content, tool args/results. Preserves structure + metadata.
 */
export function sanitizeClaudeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out = clone(entry);
  const type = out.type as string;

  // Hash cwd
  if (typeof out.cwd === "string" && isAbsolutePath(out.cwd)) {
    out.cwd = hashPath(out.cwd);
  }

  if (type === "user" || type === "assistant" || type === "system") {
    const msg = out.message as Record<string, unknown> | undefined;
    if (msg) {
      const content = msg.content;
      if (typeof content === "string") {
        msg.content = "";
      } else if (Array.isArray(content)) {
        msg.content = (content as Record<string, unknown>[]).map((block) => {
          const blockType = block.type as string;
          if (blockType === "text") {
            return { type: "text", text: "" };
          }
          if (blockType === "tool_use") {
            const toolName = block.name as string;
            const rawInput = (block.input ?? {}) as Record<string, unknown>;
            // Preserve non-sensitive metadata fields for specific tools
            let sanitizedInput: Record<string, unknown> = {};
            if (toolName === "Skill" && rawInput.skill) {
              sanitizedInput = { skill: rawInput.skill };
            } else if (toolName === "Agent") {
              sanitizedInput = {
                ...(rawInput.subagent_type ? { subagent_type: rawInput.subagent_type } : {}),
                ...(rawInput.description ? { description: rawInput.description } : {}),
                ...(rawInput.run_in_background ? { run_in_background: rawInput.run_in_background } : {}),
              };
            } else if (toolName === "Bash") {
              if (rawInput.description) sanitizedInput.description = rawInput.description;
            } else if (toolName === "Edit" || toolName === "Read" || toolName === "Write") {
              // Preserve only the filename (basename), not the full path
              const fp = rawInput.file_path as string | undefined;
              if (fp) sanitizedInput.file = fp.split("/").pop() ?? "";
              if (toolName === "Edit" && rawInput.replace_all) sanitizedInput.replace_all = true;
            } else if (toolName === "Glob") {
              if (rawInput.pattern) sanitizedInput.pattern = rawInput.pattern;
            } else if (toolName === "Grep") {
              if (rawInput.pattern) sanitizedInput.pattern = rawInput.pattern;
              if (rawInput.output_mode) sanitizedInput.output_mode = rawInput.output_mode;
            } else if (toolName === "ToolSearch") {
              if (rawInput.query) sanitizedInput.query = rawInput.query;
            } else if (toolName === "TaskCreate") {
              if (rawInput.description) sanitizedInput.description = rawInput.description;
            } else if (toolName === "TaskUpdate") {
              if (rawInput.status) sanitizedInput.status = rawInput.status;
            }
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: sanitizedInput,
            };
          }
          if (blockType === "tool_result") {
            return {
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: "",
              ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
            };
          }
          // Unknown block type — strip text-like fields, keep type
          const safe: Record<string, unknown> = { type: blockType };
          if (block.id) safe.id = block.id;
          return safe;
        });
      }
    }
  }

  // Strip queue-operation content
  if (type === "queue-operation" && typeof out.content === "string") {
    out.content = "";
  }

  // Strip hook command paths in system entries (but keep structure)
  if (type === "system") {
    const hookInfos = out.hookInfos as Record<string, unknown>[] | undefined;
    if (Array.isArray(hookInfos)) {
      out.hookInfos = hookInfos.map((h) => ({
        ...h,
        command: typeof h.command === "string" ? hashPath(h.command) : "",
      }));
    }
    const hookErrors = out.hookErrors;
    if (Array.isArray(hookErrors)) {
      out.hookErrors = (hookErrors as unknown[]).map((e) =>
        typeof e === "string" ? hashPath(e) : "",
      );
    }
  }

  return out;
}

/**
 * Sanitize a Claude history.jsonl entry.
 */
export function sanitizeClaudeHistoryEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out = clone(entry);
  if (typeof out.display === "string") out.display = "";
  if (out.pastedContents != null) out.pastedContents = {};
  if (typeof out.project === "string" && isAbsolutePath(out.project)) {
    out.project = hashPath(out.project);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex — JSONL rollout entries
// ---------------------------------------------------------------------------

/**
 * Sanitize a single Codex rollout JSONL entry ({type, payload, timestamp} envelope).
 */
export function sanitizeCodexEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out = clone(entry);
  const type = out.type as string;
  const payload = out.payload as Record<string, unknown> | undefined;
  if (!payload) return out;

  if (type === "session_meta") {
    if (typeof payload.cwd === "string") payload.cwd = hashPath(payload.cwd);
    // Strip base_instructions
    const baseInstructions = payload.base_instructions as Record<string, unknown> | undefined;
    if (baseInstructions && typeof baseInstructions.text === "string") {
      baseInstructions.text = "";
    }
  } else if (type === "response_item") {
    const ptype = payload.type as string;
    if (ptype === "message") {
      // Strip message content
      const content = payload.content;
      if (typeof content === "string") {
        payload.content = "";
      } else if (Array.isArray(content)) {
        payload.content = (content as Record<string, unknown>[]).map((block) => ({
          type: block.type,
          text: "",
        }));
      }
    } else if (ptype === "function_call") {
      // Keep name and call_id, preserve safe metadata in arguments
      const toolName = payload.name as string;
      let args: Record<string, unknown> = {};
      try {
        const raw = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : (payload.arguments ?? {});
        if (toolName === "spawn_agent") {
          if (raw.agent_type) args.agent_type = raw.agent_type;
          if (raw.model) args.model = raw.model;
          if (raw.reasoning_effort) args.reasoning_effort = raw.reasoning_effort;
        } else if (toolName === "wait_agent") {
          if (raw.timeout_ms) args.timeout_ms = raw.timeout_ms;
        }
      } catch { /* ignore */ }
      payload.arguments = JSON.stringify(args);
    } else if (ptype === "function_call_output") {
      // Keep call_id, strip output
      payload.output = "";
    }
  } else if (type === "turn_context") {
    // Strip developer instructions text if present
    const collab = payload.collaboration_mode as Record<string, unknown> | undefined;
    if (collab && typeof collab.developer_instructions === "string") {
      collab.developer_instructions = "";
    }
  }

  return out;
}

/**
 * Sanitize a Codex threads SQLite row exported as JSON.
 */
export function sanitizeCodexThread(row: Record<string, unknown>): Record<string, unknown> {
  const out = clone(row);
  if (typeof out.title === "string") out.title = "";
  if (typeof out.first_user_message === "string") out.first_user_message = "";
  if (typeof out.cwd === "string") out.cwd = hashPath(out.cwd as string);
  if (typeof out.git_origin_url === "string") out.git_origin_url = hashPath(out.git_origin_url as string);
  if (typeof out.rollout_path === "string") out.rollout_path = hashPath(out.rollout_path as string);
  if (typeof out.agent_path === "string") out.agent_path = hashPath(out.agent_path as string);
  return out;
}

// ---------------------------------------------------------------------------
// Gemini — session JSON
// ---------------------------------------------------------------------------

/**
 * Sanitize a full Gemini session JSON object.
 */
export function sanitizeGeminiSession(data: Record<string, unknown>): Record<string, unknown> {
  const out = clone(data);
  const messages = out.messages as Record<string, unknown>[] | undefined;
  if (!Array.isArray(messages)) return out;

  out.messages = messages.map((msg) => {
    // Strip content
    if (typeof msg.content === "string") {
      msg.content = "";
    } else if (Array.isArray(msg.content)) {
      msg.content = [];
    }

    // Strip thoughts
    if (Array.isArray(msg.thoughts)) {
      msg.thoughts = [];
    }

    // Sanitize tool calls — keep name, id, timestamp, status; strip args and result
    const toolCalls = msg.toolCalls as Record<string, unknown>[] | undefined;
    if (Array.isArray(toolCalls)) {
      msg.toolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: {},
        result: [],
        status: tc.status,
        timestamp: tc.timestamp,
        displayName: tc.displayName,
        description: tc.description,
        resultDisplay: "",
      }));
    }

    return msg;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Cursor Agent — SQLite export to JSONL
// ---------------------------------------------------------------------------

/**
 * Sanitize a Cursor Agent meta record (decoded from hex).
 */
export function sanitizeCursorMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out = clone(meta);
  if (typeof out.name === "string") out.name = "";
  return out;
}

/**
 * Sanitize a Cursor Agent blob record (one message).
 */
export function sanitizeCursorBlob(msg: Record<string, unknown>): Record<string, unknown> {
  const out = clone(msg);

  // Strip top-level string content
  if (typeof out.content === "string") {
    out.content = "";
  } else if (Array.isArray(out.content)) {
    out.content = (out.content as Record<string, unknown>[]).map((block) => {
      const blockType = block.type as string;
      if (blockType === "text") {
        return { type: "text", text: "" };
      }
      if (blockType === "tool-call") {
        return {
          type: "tool-call",
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          args: {},
        };
      }
      if (blockType === "tool-result") {
        return {
          type: "tool-result",
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          result: "",
        };
      }
      return { type: blockType };
    });
  }

  // Strip providerOptions diff strings
  const po = out.providerOptions as Record<string, unknown> | undefined;
  if (po?.cursor && typeof po.cursor === "object") {
    const cursor = po.cursor as Record<string, unknown>;
    const result = cursor.highLevelToolCallResult as Record<string, unknown> | undefined;
    if (result?.output && typeof result.output === "object") {
      const output = result.output as Record<string, unknown>;
      if (output.success && typeof output.success === "object") {
        const success = output.success as Record<string, unknown>;
        if (typeof success.path === "string") success.path = hashPath(success.path);
        if (typeof success.diffString === "string") success.diffString = "";
      }
      if (output.rejected && typeof output.rejected === "object") {
        const rejected = output.rejected as Record<string, unknown>;
        if (typeof rejected.command === "string") rejected.command = "";
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// OpenCode — SQLite export to JSONL
// ---------------------------------------------------------------------------

/**
 * Sanitize an OpenCode session row.
 */
export function sanitizeOpenCodeSession(row: Record<string, unknown>): Record<string, unknown> {
  const out = clone(row);
  if (typeof out.title === "string") out.title = "";
  if (typeof out.directory === "string") out.directory = hashPath(out.directory as string);
  if (typeof out.summary_diffs === "string") out.summary_diffs = "";
  if (typeof out.revert === "string" && isAbsolutePath(out.revert)) {
    out.revert = hashPath(out.revert as string);
  }
  return out;
}

/**
 * Sanitize an OpenCode message data JSON.
 */
export function sanitizeOpenCodeMessage(data: Record<string, unknown>): Record<string, unknown> {
  const out = clone(data);

  // Hash paths
  const pathObj = out.path as Record<string, unknown> | undefined;
  if (pathObj) {
    if (typeof pathObj.cwd === "string") pathObj.cwd = hashPath(pathObj.cwd);
    if (typeof pathObj.root === "string") pathObj.root = hashPath(pathObj.root);
  }

  // Strip summary diffs
  const summary = out.summary as Record<string, unknown> | undefined;
  if (summary && Array.isArray(summary.diffs)) {
    summary.diffs = [];
  }

  return out;
}

/**
 * Sanitize an OpenCode part data JSON.
 */
export function sanitizeOpenCodePart(data: Record<string, unknown>): Record<string, unknown> {
  const out = clone(data);
  const ptype = out.type as string;

  // Strip text content
  if (typeof out.text === "string") out.text = "";

  // Strip tool args/input
  if (out.args != null) out.args = {};
  if (out.input != null && typeof out.input === "object") out.input = {};

  // Strip state fields
  const state = out.state as Record<string, unknown> | undefined;
  if (state) {
    if (state.input != null && typeof state.input === "object") state.input = {};
    if (typeof state.output === "string") state.output = "";
    if (typeof state.title === "string" && isAbsolutePath(state.title)) {
      state.title = hashPath(state.title);
    }
    const meta = state.metadata as Record<string, unknown> | undefined;
    if (meta) {
      if (typeof meta.preview === "string") meta.preview = "";
      if (typeof meta.dir === "string") meta.dir = hashPath(meta.dir);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// File-level sanitization — reads raw files, returns sanitized JSONL lines
// ---------------------------------------------------------------------------

/**
 * Sanitize a Claude JSONL file. Returns sanitized lines as strings.
 */
export function sanitizeClaudeJsonlFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const lines: string[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      lines.push(JSON.stringify(sanitizeClaudeEntry(entry)));
    } catch {
      continue;
    }
  }
  return lines;
}

/**
 * Sanitize a Claude history.jsonl file. Returns sanitized lines.
 */
export function sanitizeClaudeHistoryFile(filePath: string, allowedProjects?: Set<string>): string[] {
  if (!existsSync(filePath)) return [];
  const lines: string[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Filter by project if allowedProjects is set
      if (allowedProjects && entry.project) {
        const slug = entry.project.split("/").pop() || "";
        if (!allowedProjects.has(slug)) continue;
      }
      lines.push(JSON.stringify(sanitizeClaudeHistoryEntry(entry)));
    } catch {
      continue;
    }
  }
  return lines;
}

/**
 * Sanitize a Claude history.jsonl file, grouped by project slug.
 * Returns a Map of project_slug → sanitized lines.
 */
export function sanitizeClaudeHistoryFileByProject(filePath: string, allowedProjects?: Set<string>): Map<string, string[]> {
  if (!existsSync(filePath)) return new Map();
  const byProject = new Map<string, string[]>();
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const projectPath = entry.project || "";
      const slug = projectPath.split("/").pop() || "_unknown";
      // Filter by project if allowedProjects is set
      if (allowedProjects && projectPath) {
        if (!allowedProjects.has(slug)) continue;
      }
      if (!byProject.has(slug)) byProject.set(slug, []);
      byProject.get(slug)!.push(JSON.stringify(sanitizeClaudeHistoryEntry(entry)));
    } catch {
      continue;
    }
  }
  return byProject;
}

/**
 * Extract raw session_id → project_slug mapping from Codex threads SQLite.
 * Uses the raw `cwd` field (before sanitization) to derive project basenames.
 */
export function extractCodexThreadProjectMap(dbPath: string): Map<string, string> {
  if (!existsSync(dbPath)) return new Map();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT id, cwd FROM threads").all() as { id: string; cwd: string }[];
    db.close();
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.id && row.cwd) {
        const slug = basename(row.cwd.replace(/[/\\]+$/, "")) || "_unknown";
        map.set(row.id, slug);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Extract project slug → cwd path mapping from Codex threads DB. */
export function extractCodexProjectPaths(dbPath: string): Map<string, string> {
  if (!existsSync(dbPath)) return new Map();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT cwd FROM threads").all() as { cwd: string }[];
    db.close();
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.cwd) {
        const cwd = row.cwd.replace(/[/\\]+$/, "");
        const slug = basename(cwd) || "_unknown";
        if (slug !== "_harness" && !map.has(slug)) {
          map.set(slug, cwd);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Sanitize a Codex rollout JSONL file. Returns sanitized lines.
 */
export function sanitizeCodexRolloutFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const lines: string[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      lines.push(JSON.stringify(sanitizeCodexEntry(entry)));
    } catch {
      continue;
    }
  }
  return lines;
}

/**
 * Export and sanitize Codex threads from SQLite. Returns sanitized JSONL lines.
 */
export function sanitizeCodexThreadsDb(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM threads").all() as Record<string, unknown>[];
    db.close();
    return rows.map((row) => JSON.stringify(sanitizeCodexThread(row)));
  } catch {
    return [];
  }
}

/**
 * Export and sanitize Codex spawn edges from SQLite. Returns JSONL lines.
 */
export function sanitizeCodexSpawnEdges(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges"
    ).all() as Record<string, unknown>[];
    db.close();
    // No sensitive data in spawn edges — pass through
    return rows.map((row) => JSON.stringify(row));
  } catch {
    return [];
  }
}

/**
 * Sanitize a Gemini session JSON file. Returns the full sanitized JSON as a single string.
 */
export function sanitizeGeminiSessionFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return JSON.stringify(sanitizeGeminiSession(data));
  } catch {
    return "";
  }
}

/**
 * Export and sanitize a Cursor Agent store.db. Returns sanitized JSONL lines
 * (first line = meta, subsequent lines = blob messages).
 */
export function sanitizeCursorDb(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const lines: string[] = [];

    // Meta table — hex-encoded JSON
    const metaRow = db.prepare("SELECT * FROM meta LIMIT 1").get() as Record<string, unknown> | undefined;
    if (metaRow) {
      for (const val of Object.values(metaRow)) {
        if (typeof val === "string" && val.length > 20) {
          try {
            const decoded = JSON.parse(Buffer.from(val, "hex").toString("utf-8"));
            if (typeof decoded === "object" && decoded !== null) {
              lines.push(JSON.stringify({ _type: "meta", ...sanitizeCursorMeta(decoded) }));
              break;
            }
          } catch { /* try next column */ }
        }
      }
    }

    // Blobs table — message data
    const blobs = db.prepare("SELECT data FROM blobs").all() as { data: Buffer | string }[];
    for (const blob of blobs) {
      try {
        let msg: Record<string, unknown>;
        if (Buffer.isBuffer(blob.data)) {
          msg = JSON.parse(Buffer.from(blob.data).toString("utf-8"));
        } else if (typeof blob.data === "string") {
          msg = JSON.parse(Buffer.from(blob.data, "hex").toString("utf-8"));
        } else {
          continue;
        }
        if (typeof msg === "object" && msg !== null) {
          lines.push(JSON.stringify({ _type: "blob", ...sanitizeCursorBlob(msg) }));
        }
      } catch {
        continue;
      }
    }

    db.close();
    return lines;
  } catch {
    return [];
  }
}

/**
 * Export and sanitize OpenCode sessions from SQLite. Returns sanitized JSONL lines.
 * Each line is tagged with _type: "session" | "message" | "part".
 */
export function sanitizeOpenCodeDb(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const lines: string[] = [];

    // Sessions
    const sessions = db.prepare("SELECT * FROM session").all() as Record<string, unknown>[];
    for (const row of sessions) {
      lines.push(JSON.stringify({ _type: "session", ...sanitizeOpenCodeSession(row) }));
    }

    // Messages
    const messages = db.prepare("SELECT * FROM message").all() as Record<string, unknown>[];
    for (const row of messages) {
      const sanitized: Record<string, unknown> = {
        _type: "message",
        id: row.id,
        session_id: row.session_id,
        time_created: row.time_created,
        time_updated: row.time_updated,
      };
      if (typeof row.data === "string") {
        try {
          sanitized.data = sanitizeOpenCodeMessage(JSON.parse(row.data));
        } catch {
          sanitized.data = {};
        }
      }
      lines.push(JSON.stringify(sanitized));
    }

    // Parts
    const parts = db.prepare("SELECT * FROM part").all() as Record<string, unknown>[];
    for (const row of parts) {
      const sanitized: Record<string, unknown> = {
        _type: "part",
        id: row.id,
        message_id: row.message_id,
        session_id: row.session_id,
        time_created: row.time_created,
        time_updated: row.time_updated,
      };
      if (typeof row.data === "string") {
        try {
          sanitized.data = sanitizeOpenCodePart(JSON.parse(row.data));
        } catch {
          sanitized.data = {};
        }
      }
      lines.push(JSON.stringify(sanitized));
    }

    db.close();
    return lines;
  } catch {
    return [];
  }
}
