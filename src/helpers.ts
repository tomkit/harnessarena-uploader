import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { Harness } from "./models.js";

export function makeSessionId(harness: Harness, sourceId: string): string {
  return createHash("sha256").update(`${harness}:${sourceId}`).digest("hex");
}

export function machineId(): string {
  return createHash("sha256").update(hostname()).digest("hex");
}

export function basenameOnly(path: string | null | undefined): string | null {
  if (path == null) return null;
  const name = basename(path.replace(/[/\\]+$/, ""));
  return name || null;
}

/**
 * Decode a Claude Code project directory name to the project basename.
 * e.g. "-Users-tomkit-Projects-angry-bird-clone" → "angry-bird-clone"
 */
export function decodeClaudeProjectDir(encodedName: string): string | null {
  const knownParents = [
    "-Projects-", "-Downloads-", "-Documents-", "-Desktop-",
    "-repos-", "-src-", "-code-", "-workspace-", "-work-",
  ];
  for (const parent of knownParents) {
    const idx = encodedName.lastIndexOf(parent);
    if (idx >= 0) {
      return encodedName.slice(idx + parent.length);
    }
  }
  const parts = encodedName.replace(/^-+/, "").split("-");
  return parts.at(-1) || null;
}

export function utcnowIso(): string {
  return new Date().toISOString();
}

export function safeInt(val: unknown, defaultVal = 0): number {
  if (val == null) return defaultVal;
  const n = Number(val);
  return Number.isInteger(n) ? n : defaultVal;
}

export function epochToIso(val: unknown): string {
  if (val == null) return "";
  try {
    let ts = Number(val);
    if (Number.isNaN(ts)) return "";
    if (ts > 1e12) ts = ts / 1000;
    return new Date(ts * 1000).toISOString();
  } catch {
    return "";
  }
}

export function parseTimestamp(val: unknown): string {
  if (val == null) return "";
  const s = String(val);
  if (s.includes("T") || s.includes("-") || s.includes(":")) {
    try {
      const d = new Date(s.replace("Z", "+00:00"));
      if (!Number.isNaN(d.getTime())) return s;
    } catch {
      // fall through
    }
  }
  return epochToIso(val);
}

const PROMPT_KEY_BUCKET_MS = 5000;

export function makePromptKey(displayText: string, timestampMs: number): string {
  const bucket = Math.floor(timestampMs / PROMPT_KEY_BUCKET_MS);
  return `${displayText.slice(0, 100)}|${bucket}`;
}

export function registerMcpTool(
  mcpServers: Record<string, Record<string, unknown>>,
  toolName: string,
): void {
  let serverName: string;
  let primitiveName: string;

  if (toolName.startsWith("mcp__")) {
    const remainder = toolName.slice(5);
    if (remainder.includes("__")) {
      [serverName, primitiveName] = remainder.split("__", 2);
    } else if (remainder.includes("_")) {
      [serverName, primitiveName] = remainder.split("_", 2);
    } else {
      serverName = remainder;
      primitiveName = toolName;
    }
  } else if (toolName.startsWith("mcp_")) {
    const remainder = toolName.slice(4);
    if (remainder.includes("_")) {
      [serverName, primitiveName] = remainder.split("_", 2);
    } else {
      serverName = remainder;
      primitiveName = toolName;
    }
  } else {
    return;
  }

  if (!mcpServers[serverName]) {
    mcpServers[serverName] = { invocation_count: 0, uri: null, primitives: {} };
  }
  const server = mcpServers[serverName];
  server.invocation_count = (server.invocation_count as number) + 1;
  const primitives = server.primitives as Record<string, Record<string, unknown>>;
  if (!primitives[primitiveName]) {
    primitives[primitiveName] = { primitive_type: "tool", invocation_count: 0 };
  }
  primitives[primitiveName].invocation_count =
    (primitives[primitiveName].invocation_count as number) + 1;
}

export function extractUserDisplayText(entry: Record<string, unknown>): string {
  const msg = (entry.message ?? {}) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === "string") return content.slice(0, 100);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string" && text) return text.slice(0, 100);
      }
    }
  }
  return "";
}
