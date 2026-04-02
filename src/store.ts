/**
 * Persistent state stored in ~/.harnessarena/
 *
 * config.json  — user preferences, wizard selections, API credentials
 * watermarks.json — per-file upload watermarks for delta sync
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE_DIR = join(homedir(), ".harnessarena");
const WATERMARKS_PATH = join(STORE_DIR, "watermarks.json");

let _devMode = false;

/** Set dev mode — must be called before any config reads. Switches to config.local.json. */
export function setDevMode(dev: boolean): void {
  _devMode = dev;
}

export function isDevMode(): boolean {
  return _devMode;
}

function configPath(): string {
  return join(STORE_DIR, _devMode ? "config.local.json" : "config.json");
}

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Config — user preferences and wizard state
// ---------------------------------------------------------------------------

/**
 * Sync scope: per-harness project filter.
 *
 * Keys are harness slugs (claude, codex, gemini, agent, opencode).
 * Values:
 *   ["*"]            — sync all projects for this harness
 *   ["proj1", ...]   — sync only these projects
 *   false            — skip this harness entirely
 *
 * When syncScope is undefined, all harnesses and all projects are synced.
 */
export type SyncScope = Record<string, string[] | false>;

export interface Config {
  /** API key for harnessarena.com */
  apiKey?: string;
  /** User slug (GitHub username, set during login) */
  userSlug?: string;
  /** Per-harness project sync scope. Written by wizard, editable by user. */
  syncScope?: SyncScope;
}

/**
 * Resolve effective harnesses and project filter from config + CLI flags.
 *
 * Priority: CLI flags override syncScope config.
 * - No flags: use syncScope (or all if unset)
 * - --harness only: filter harnesses, all projects per harness
 * - --projects only: all harnesses from syncScope, filter projects
 * - Both: filter harnesses, filter projects within those harnesses
 */
export function resolveSyncScope(
  allHarnesses: string[],
  config: Config,
  harnessFlags: string[],
  projectFlags: string[],
): { harnesses: string[]; projectFilter: (harness: string, project: string) => boolean } {
  const scope = config.syncScope;

  // Determine active harnesses
  let harnesses: string[];
  if (harnessFlags.length > 0) {
    harnesses = harnessFlags;
  } else if (scope) {
    harnesses = Object.keys(scope).filter((h) => scope[h] !== false);
  } else {
    harnesses = allHarnesses;
  }

  // Build project filter
  const harnessOverridden = harnessFlags.length > 0;
  const projectFilter = (harness: string, project: string): boolean => {
    // CLI --projects flag takes precedence
    if (projectFlags.length > 0) {
      return projectFlags.includes(project);
    }
    // If harness was explicitly requested via CLI, include all its projects
    // (don't let syncScope's false/project-list block it)
    if (harnessOverridden) {
      return true;
    }
    // Fall back to syncScope config
    if (scope && scope[harness] !== undefined) {
      const harnessScope = scope[harness];
      if (harnessScope === false) return false;
      if (Array.isArray(harnessScope)) {
        if (harnessScope.includes("*")) return true;
        return harnessScope.includes(project);
      }
    }
    // No scope defined: include everything
    return true;
  };

  return { harnesses, projectFilter };
}

export function loadConfig(): Config {
  return readJson<Config>(configPath(), {});
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config);
}

export function updateConfig(partial: Partial<Config>): Config {
  const config = loadConfig();
  Object.assign(config, partial);
  saveConfig(config);
  return config;
}

// ---------------------------------------------------------------------------
// Watermarks — per-file hash tracking for delta sync
// ---------------------------------------------------------------------------

/**
 * Watermark for an append-only file (Claude JSONL, Codex rollout, history.jsonl).
 * Tracks the hash of the last uploaded line so we can find our place even after
 * the file is pruned/rotated.
 */
export interface AppendWatermark {
  mode: "append";
  /** SHA-256 of the last uploaded line content */
  lastLineHash: string;
  /** Line number of the last uploaded line (hint — not authoritative after pruning) */
  lastLineNumber: number;
  /** Number of lines uploaded so far from this file */
  totalLinesUploaded: number;
  /** ISO timestamp of last upload */
  uploadedAt: string;
}

/**
 * Watermark for a rewritten file (Gemini JSON, Cursor/OpenCode SQLite export).
 * Tracks the hash of the full sanitized content to skip unchanged files.
 */
export interface ReplaceWatermark {
  mode: "replace";
  /** SHA-256 of the entire sanitized file content */
  contentHash: string;
  /** ISO timestamp of last upload */
  uploadedAt: string;
}

export type Watermark = AppendWatermark | ReplaceWatermark;

/**
 * Watermarks keyed by blob namespace path:
 * {orgSlug}/{userSlug}/{projectSlug}/{logType}/{sourceFile}
 */
export type WatermarkStore = Record<string, Watermark>;

export function loadWatermarks(): WatermarkStore {
  return readJson<WatermarkStore>(WATERMARKS_PATH, {});
}

export function saveWatermarks(watermarks: WatermarkStore): void {
  writeJson(WATERMARKS_PATH, watermarks);
}

let _ignoreWatermarks = false;

/** Temporarily ignore all watermarks (for force preview dry runs). */
export function setIgnoreWatermarks(ignore: boolean): void {
  _ignoreWatermarks = ignore;
}

export function getWatermark(key: string): Watermark | null {
  if (_ignoreWatermarks) return null;
  const watermarks = loadWatermarks();
  return watermarks[key] ?? null;
}

export function setWatermark(key: string, watermark: Watermark): void {
  const watermarks = loadWatermarks();
  watermarks[key] = watermark;
  saveWatermarks(watermarks);
}

// ---------------------------------------------------------------------------
// Blob namespace helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a client-side source path for use in blob namespace keys.
 *
 * - Replaces path separators (/ and \) with -- to keep a flat hierarchy
 * - Strips leading separators
 * - Collapses multiple separators
 *
 * Examples:
 *   "2026/03/31/rollout-xyz.jsonl" → "2026--03--31--rollout-xyz.jsonl"
 *   "abc123/agent-a1b2c3.jsonl"   → "abc123--agent-a1b2c3.jsonl"
 *   "sessions-index.json"          → "sessions-index.json" (unchanged)
 */
export function canonicalizePath(sourcePath: string): string {
  return sourcePath
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+/g, "--");
}

/**
 * Build the blob namespace key for a file.
 *
 * Client-side layout: {userSlug}/{harness}/{projectSlug}/{logType}/{canonicalizedSourcePath}
 *
 * The server prepends the org slug (server-authoritative, scoped to API key).
 *
 * harness values: claude, codex, gemini, cursor, opencode
 *
 * logType values (consistent across harnesses):
 *   session    — primary session data (Claude JSONL, Codex rollout, Gemini JSON, Cursor/OpenCode export)
 *   subagent   — subagent session data (Claude subagent JSONL)
 *   meta       — metadata/indexes (Claude sessions-index.json, Codex threads + spawn_edges)
 *   history    — cross-session prompt history (Claude history.jsonl)
 */
export function blobKey(
  userSlug: string,
  harness: string,
  projectSlug: string,
  logType: string,
  sourcePath: string,
): string {
  return `${userSlug}/${harness}/${projectSlug}/${logType}/${canonicalizePath(sourcePath)}`;
}

/** Path to the ~/.harnessarena directory */
export const STORE_PATH = STORE_DIR;
