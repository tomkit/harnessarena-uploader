/**
 * Sync command — discovers harness log files, sanitizes them, diffs against
 * watermarks, and uploads deltas to the server's blob-sync endpoint.
 *
 * Two modes per file:
 *   append  — for append-only files (Claude JSONL, Codex rollout JSONL, history.jsonl)
 *             Finds the watermark line by hash, sends only new lines.
 *   replace — for rewritten files (Gemini JSON, Cursor/OpenCode SQLite exports)
 *             Hashes full sanitized content, skips if unchanged.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { gzipSync } from "node:zlib";
import {
  getClaudeHistoryPaths,
  getCodexHistoryPaths,
  getCursorHistoryPaths,
  getGeminiHistoryPaths,
  getOpenCodeHistoryPaths,
} from "./history-paths.js";
import { Harness } from "./models.js";
import {
  sanitizeClaudeJsonlFile,
  sanitizeClaudeHistoryFile,
  sanitizeCodexRolloutFile,
  sanitizeCodexThreadsDb,
  sanitizeCodexSpawnEdges,
  sanitizeGeminiSessionFile,
  sanitizeCursorDb,
  sanitizeOpenCodeDb,
} from "./sanitize.js";
import {
  blobKey,
  getWatermark,
  setWatermark,
  loadWatermarks,
  saveWatermarks,
  type AppendWatermark,
  type ReplaceWatermark,
  type Watermark,
} from "./store.js";
import { VERSION } from "./version.js";
import { basenameOnly, decodeClaudeProjectDir, decodeClaudeProjectDirFull } from "./helpers.js";
import { collectHarnessInventory, collectProjectInventory } from "./batch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  filesScanned: number;
  filesUploaded: number;
  filesSkipped: number;
  linesUploaded: number;
  errors: string[];
}

export interface BlobDelta {
  /** Blob namespace key */
  key: string;
  /** append or replace */
  mode: "append" | "replace";
  /**
   * full    — first sync of this source file (no prior watermark)
   * partial — delta from watermark to EOF on an append-only source
   * replace — new version of a rewritable source (gemini/cursor/opencode)
   */
  uploadType: "full" | "partial" | "replace";
  /** Sanitized lines to upload */
  lines: string[];
  /** Project slug derived from the file path */
  projectSlug: string;
  /** Log type identifier */
  logType: string;
  /** Watermark to persist after successful upload */
  pendingWatermark: { key: string; watermark: import("./store.js").Watermark };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readdirRecursive(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readdirRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Compute the delta for an append-only file.
 * Returns only lines after the watermark. If the watermark line can't be found
 * (file was pruned), returns all lines.
 */
function computeAppendDelta(
  allLines: string[],
  watermark: AppendWatermark | null,
): { newLines: string[]; lastLineHash: string; lastLineNumber: number } {
  if (allLines.length === 0) {
    return { newLines: [], lastLineHash: "", lastLineNumber: 0 };
  }

  if (!watermark) {
    // No watermark — upload everything
    return {
      newLines: allLines,
      lastLineHash: hashLine(allLines[allLines.length - 1]),
      lastLineNumber: allLines.length,
    };
  }

  // Try to find the watermark line by hash.
  // Start searching near the expected position (hint), then fall back to full scan.
  const hint = watermark.lastLineNumber - 1; // 0-indexed
  let foundIdx = -1;

  // Check the hint position first
  if (hint >= 0 && hint < allLines.length && hashLine(allLines[hint]) === watermark.lastLineHash) {
    foundIdx = hint;
  } else {
    // Scan backwards from the end (watermark is likely near where it was)
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (hashLine(allLines[i]) === watermark.lastLineHash) {
        foundIdx = i;
        break;
      }
    }
  }

  if (foundIdx === -1) {
    // Watermark line not found — file was pruned. Upload everything.
    return {
      newLines: allLines,
      lastLineHash: hashLine(allLines[allLines.length - 1]),
      lastLineNumber: allLines.length,
    };
  }

  // Found the watermark line — return only lines after it
  const newLines = allLines.slice(foundIdx + 1);
  const lastLine = newLines.length > 0 ? newLines[newLines.length - 1] : allLines[foundIdx];
  return {
    newLines,
    lastLineHash: hashLine(lastLine),
    lastLineNumber: foundIdx + 1 + newLines.length,
  };
}

/** Create an append delta with a deferred watermark (not persisted until upload succeeds). */
function makeAppendDelta(
  key: string,
  newLines: string[],
  lastLineHash: string,
  lastLineNumber: number,
  existingWatermark: AppendWatermark | null,
  projectSlug: string,
  logType: string,
): BlobDelta | null {
  if (newLines.length === 0) return null;
  return {
    key,
    mode: "append",
    uploadType: existingWatermark ? "partial" : "full",
    lines: newLines,
    projectSlug,
    logType,
    pendingWatermark: {
      key,
      watermark: {
        mode: "append",
        lastLineHash,
        lastLineNumber,
        totalLinesUploaded: (existingWatermark?.totalLinesUploaded ?? 0) + newLines.length,
        uploadedAt: new Date().toISOString(),
      },
    },
  };
}

/** Create a replace delta with a deferred watermark, or null if content unchanged. */
function makeReplaceDelta(
  key: string,
  lines: string[],
  contentHash: string,
  projectSlug: string,
  logType: string,
): BlobDelta | null {
  const watermark = getWatermark(key);
  if (watermark?.mode === "replace" && watermark.contentHash === contentHash) return null;
  return {
    key,
    mode: "replace",
    uploadType: "replace",
    lines,
    projectSlug,
    logType,
    pendingWatermark: {
      key,
      watermark: { mode: "replace", contentHash, uploadedAt: new Date().toISOString() },
    },
  };
}

// ---------------------------------------------------------------------------
// Per-harness file discovery + sanitization
// ---------------------------------------------------------------------------

function discoverClaudeDeltas(
  userSlug: string,
  allowedProjects?: Set<string>,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];
  const paths = getClaudeHistoryPaths();

  // 1. Session JSONL files in ~/.claude/projects/
  if (existsSync(paths.projectsDir)) {
    for (const projectDir of readdirSync(paths.projectsDir, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = join(paths.projectsDir, projectDir.name);
      const projectSlug = decodeClaudeProjectDir(projectDir.name) || projectDir.name;

      // Session JSONL files
      for (const file of readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"))) {
        const filePath = join(projectPath, file);
        const allLines = sanitizeClaudeJsonlFile(filePath);
        const key = blobKey(userSlug, "claude", projectSlug, "session", file);
        const wm = getWatermark(key);
        const { newLines, lastLineHash, lastLineNumber } = computeAppendDelta(allLines, wm?.mode === "append" ? wm : null);
        const delta = makeAppendDelta(key, newLines, lastLineHash, lastLineNumber, wm?.mode === "append" ? wm : null, projectSlug, "session");
        if (delta) deltas.push(delta);
      }

      // Subagent JSONL files
      for (const sessionDir of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sessionDir.isDirectory()) continue;
        const subagentsDir = join(projectPath, sessionDir.name, "subagents");
        if (!existsSync(subagentsDir)) continue;
        for (const file of readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"))) {
          const filePath = join(subagentsDir, file);
          const allLines = sanitizeClaudeJsonlFile(filePath);
          const subKey = blobKey(userSlug, "claude", projectSlug, "subagent", `${sessionDir.name}/${file}`);
          const wm = getWatermark(subKey);
          const { newLines, lastLineHash, lastLineNumber } = computeAppendDelta(allLines, wm?.mode === "append" ? wm : null);
          const delta = makeAppendDelta(subKey, newLines, lastLineHash, lastLineNumber, wm?.mode === "append" ? wm : null, projectSlug, "subagent");
          if (delta) deltas.push(delta);
        }
      }

      // sessions-index.json (replace mode)
      const indexPath = join(projectPath, "sessions-index.json");
      if (existsSync(indexPath)) {
        try {
          const content = readFileSync(indexPath, "utf-8");
          const indexKey = blobKey(userSlug, "claude", projectSlug, "meta", "sessions-index.json");
          const delta = makeReplaceDelta(indexKey, [content], hashContent(content), projectSlug, "meta");
          if (delta) deltas.push(delta);
        } catch { /* skip */ }
      }
    }
  }

  // 2. history.jsonl (append mode)
  if (existsSync(paths.historyPath)) {
    const allLines = sanitizeClaudeHistoryFile(paths.historyPath, allowedProjects);
    const key = blobKey(userSlug, "claude", "_global", "history", "history.jsonl");
    const wm = getWatermark(key);
    const { newLines, lastLineHash, lastLineNumber } = computeAppendDelta(allLines, wm?.mode === "append" ? wm : null);
    const delta = makeAppendDelta(key, newLines, lastLineHash, lastLineNumber, wm?.mode === "append" ? wm : null, "_global", "history");
    if (delta) deltas.push(delta);
  }

  return deltas;
}

function discoverCodexDeltas(
  userSlug: string,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];
  const paths = getCodexHistoryPaths();

  // 1. Threads table export (replace mode)
  if (existsSync(paths.stateDbPath)) {
    const lines = sanitizeCodexThreadsDb(paths.stateDbPath);
    if (lines.length > 0) {
      const key = blobKey(userSlug, "codex", "_global", "meta", "threads.jsonl");
      const delta = makeReplaceDelta(key, lines, hashContent(lines.join("\n")), "_global", "meta");
      if (delta) deltas.push(delta);
    }

    const edgeLines = sanitizeCodexSpawnEdges(paths.stateDbPath);
    if (edgeLines.length > 0) {
      const key = blobKey(userSlug, "codex", "_global", "meta", "spawn_edges.jsonl");
      const delta = makeReplaceDelta(key, edgeLines, hashContent(edgeLines.join("\n")), "_global", "meta");
      if (delta) deltas.push(delta);
    }
  }

  // 2. Rollout JSONL files (append mode)
  if (existsSync(paths.sessionsDir)) {
    for (const file of readdirRecursive(paths.sessionsDir, ".jsonl")) {
      const relPath = relative(paths.sessionsDir, file);
      const allLines = sanitizeCodexRolloutFile(file);
      const key = blobKey(userSlug, "codex", "_global", "session", relPath);
      const wm = getWatermark(key);
      const { newLines, lastLineHash, lastLineNumber } = computeAppendDelta(allLines, wm?.mode === "append" ? wm : null);
      const delta = makeAppendDelta(key, newLines, lastLineHash, lastLineNumber, wm?.mode === "append" ? wm : null, "_global", "session");
      if (delta) deltas.push(delta);
    }
  }

  return deltas;
}

function discoverGeminiDeltas(
  userSlug: string,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];
  const paths = getGeminiHistoryPaths();

  if (!existsSync(paths.tmpDir)) return deltas;

  for (const projectDir of readdirSync(paths.tmpDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const chatsDir = join(paths.tmpDir, projectDir.name, "chats");
    if (!existsSync(chatsDir)) continue;

    // Use the project hash dir name as the slug (server will resolve via projects.json)
    const projectSlug = projectDir.name;

    for (const file of readdirSync(chatsDir).filter((f) => f.endsWith(".json"))) {
      const filePath = join(chatsDir, file);
      const sanitized = sanitizeGeminiSessionFile(filePath);
      if (!sanitized) continue;

      const key = blobKey(userSlug, "gemini", projectSlug, "session", file);
      const delta = makeReplaceDelta(key, [sanitized], hashContent(sanitized), projectSlug, "session");
      if (delta) deltas.push(delta);
    }
  }

  return deltas;
}

function discoverCursorDeltas(
  userSlug: string,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];
  const paths = getCursorHistoryPaths();

  if (!existsSync(paths.chatsDir)) return deltas;

  for (const dbFile of readdirRecursive(paths.chatsDir, "store.db")) {
    // Path: ~/.cursor/chats/{hash}/{uuid}/store.db
    const uuidDir = join(dbFile, "..");
    const uuid = basename(uuidDir);

    const lines = sanitizeCursorDb(dbFile);
    if (lines.length === 0) continue;

    const key = blobKey(userSlug, "cursor", "_global", "session", `${uuid}.jsonl`);
    const delta = makeReplaceDelta(key, lines, hashContent(lines.join("\n")), "_cursor", "session");
    if (delta) deltas.push(delta);
  }

  return deltas;
}

function discoverOpenCodeDeltas(
  userSlug: string,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];
  const paths = getOpenCodeHistoryPaths();

  if (!existsSync(paths.dbPath)) return deltas;

  const lines = sanitizeOpenCodeDb(paths.dbPath);
  if (lines.length === 0) return deltas;

  const key = blobKey(userSlug, "opencode", "_global", "session", "opencode.jsonl");
  const delta = makeReplaceDelta(key, lines, hashContent(lines.join("\n")), "_global", "session");
  if (delta) deltas.push(delta);

  return deltas;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all deltas across selected harnesses, filtered by project scope.
 */
export type ProjectFilter = (harness: string, project: string) => boolean;

export function discoverDeltas(
  harnesses: Harness[],
  userSlug: string,
  projectFilter?: ProjectFilter,
  allowedProjects?: Set<string>,
): BlobDelta[] {
  const pf = projectFilter ?? (() => true);
  const allDeltas: BlobDelta[] = [];

  for (const harness of harnesses) {
    let deltas: BlobDelta[];
    switch (harness) {
      case Harness.CLAUDE: deltas = discoverClaudeDeltas(userSlug, allowedProjects); break;
      case Harness.CODEX: deltas = discoverCodexDeltas(userSlug); break;
      case Harness.GEMINI: deltas = discoverGeminiDeltas(userSlug); break;
      case Harness.AGENT: deltas = discoverCursorDeltas(userSlug); break;
      case Harness.OPENCODE: deltas = discoverOpenCodeDeltas(userSlug); break;
      default: deltas = [];
    }
    // Apply project filter. _global projects always pass (cross-project data).
    allDeltas.push(...deltas.filter((d) => d.projectSlug === "_global" || pf(harness, d.projectSlug)));
  }

  return allDeltas;
}

// ---------------------------------------------------------------------------
// Upload directly to MotherDuck via server API
// ---------------------------------------------------------------------------

/** Max uncompressed bytes per batch (~4MB, gzip-compressed before sending) */
// Batch by uncompressed size. JSON compresses ~5-10x with gzip, and Vercel
// accepts up to 4.5MB compressed. 8MB balances batch count vs server processing time.
const BATCH_MAX_BYTES = 8 * 1024 * 1024;

interface IngestResult {
  ingested: number;
  errors: number;
  errorDetails?: Array<{ namespace: string; error: string }>;
  committed?: { archived: number; promoted: number };
}

/**
 * Upload a batch of deltas to the server for direct MotherDuck ingest.
 */
async function uploadBatchToServer(
  deltas: BlobDelta[],
  apiUrl: string,
  apiKey: string,
  staging = false,
  finalize = false,
): Promise<IngestResult> {
  const files = deltas.map((d) => ({
    namespace: d.key,
    type: d.uploadType,
    content: d.lines.join("\n"),
    contentHash: hashContent(d.lines.join("\n")),
  }));

  try {
    const jsonBody = JSON.stringify({ files, staging, finalize });
    const compressed = gzipSync(jsonBody);
    const resp = await fetch(`${apiUrl}/api/v1/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": `harnessarena-uploader/${VERSION}`,
      },
      body: compressed,
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      process.stderr.write(`  Batch upload failed: HTTP ${resp.status} ${text.slice(0, 500)}\n`);
      return { ingested: 0, errors: deltas.length };
    }
    const json = await resp.json() as IngestResult;
    if (json.errorDetails?.length) {
      for (const e of json.errorDetails) {
        process.stderr.write(`  ${e.namespace}: ${e.error}\n`);
      }
    }
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Batch upload error: ${msg}\n`);
    return { ingested: 0, errors: deltas.length };
  }
}

/**
 * Split deltas into batches by size (~2MB max per batch).
 * Files larger than the limit get their own batch.
 */
function splitIntoBatches(deltas: BlobDelta[]): BlobDelta[][] {
  const batches: BlobDelta[][] = [];
  let current: BlobDelta[] = [];
  let currentBytes = 0;

  for (const delta of deltas) {
    const deltaBytes = delta.lines.reduce((sum, l) => sum + l.length, 0);

    // Oversized file — split its lines across multiple batches
    if (deltaBytes > BATCH_MAX_BYTES) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      // Split lines into chunks that fit in BATCH_MAX_BYTES
      let chunkLines: string[] = [];
      let chunkBytes = 0;
      for (const line of delta.lines) {
        if (chunkLines.length > 0 && chunkBytes + line.length > BATCH_MAX_BYTES) {
          batches.push([{ ...delta, lines: chunkLines }]);
          chunkLines = [];
          chunkBytes = 0;
        }
        chunkLines.push(line);
        chunkBytes += line.length;
      }
      if (chunkLines.length > 0) {
        batches.push([{ ...delta, lines: chunkLines }]);
      }
      continue;
    }

    if (current.length > 0 && currentBytes + deltaBytes > BATCH_MAX_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(delta);
    currentBytes += deltaBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------
// Project alias discovery + sync
// ---------------------------------------------------------------------------

export interface ProjectAlias {
  userSlug: string;
  harness: string;
  rawSlug: string;
  displaySlug: string;
  source: string;
}

/**
 * Discover project aliases from all harness-specific sources.
 * - Gemini: ~/.gemini/projects.json maps sha256(path) → display name
 * - Codex/OpenCode: hashed cwd/directory — basename extracted
 */
function discoverProjectAliases(
  harnesses: Harness[],
  userSlug: string,
): ProjectAlias[] {
  const aliases: ProjectAlias[] = [];

  if (harnesses.includes(Harness.GEMINI)) {
    const paths = getGeminiHistoryPaths();
    // Gemini projects.json: maps full path → display name
    const projectsFile = join(paths.home, "projects.json");
    if (existsSync(projectsFile)) {
      try {
        const data = JSON.parse(readFileSync(projectsFile, "utf-8"));
        const projects = data?.projects;
        if (typeof projects === "object" && projects !== null) {
          for (const [fullPath, displayName] of Object.entries(projects)) {
            if (typeof fullPath !== "string") continue;
            const projectHash = createHash("sha256").update(fullPath).digest("hex");
            const name = typeof displayName === "string" && displayName.trim()
              ? displayName.trim()
              : basename(fullPath);
            aliases.push({
              userSlug, harness: "gemini",
              rawSlug: projectHash,
              displaySlug: name,
              source: "gemini-projects-json",
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  return aliases;
}

/**
 * Sync project aliases to the server.
 */
async function syncProjectAliases(
  aliases: ProjectAlias[],
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  if (aliases.length === 0) return;

  const body = JSON.stringify({ aliases });
  const compressed = gzipSync(body);

  try {
    const resp = await fetch(`${apiUrl}/api/v1/sync/aliases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        Authorization: `Bearer ${apiKey}`,
      },
      body: compressed,
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) {
      const json = await resp.json() as { upserted: number };
      process.stderr.write(`  Synced ${json.upserted} project alias(es).\n`);
    } else {
      process.stderr.write(`  Alias sync failed: HTTP ${resp.status}\n`);
    }
  } catch (err) {
    process.stderr.write(`  Alias sync error: ${err}\n`);
  }
}

/**
 * Collect harness inventory for sync as BlobDelta entries.
 *
 * Produces two scopes per harness:
 *   - _global (user-level): native tools, agents, user-level skills/plugins
 *   - per-project: project-scoped plugins and MCP servers (Claude, Gemini)
 *
 * Each inventory blob is uploaded as a replace-mode raw_entries row with
 * log_type='inventory', making it queryable in the same bronze layer as
 * session data.
 */
export function discoverHarnessInventory(
  harnesses: Harness[],
  userSlug: string,
): BlobDelta[] {
  const deltas: BlobDelta[] = [];

  for (const harness of harnesses) {
    // 1. User-level (_global) inventory — new primitives/plugins format
    const inv = collectHarnessInventory(harness);
    const globalData = JSON.stringify({
      primitives: inv.primitives,
      plugins: inv.plugins,
    });
    const globalKey = blobKey(userSlug, harness, "_global", "inventory", "primitives.json");
    const globalDelta = makeReplaceDelta(globalKey, [globalData], hashContent(globalData), "_global", "inventory");
    if (globalDelta) deltas.push(globalDelta);

    // 2. Project-level inventory (Claude and Gemini only)
    if (harness === Harness.CLAUDE) {
      const paths = getClaudeHistoryPaths();
      if (existsSync(paths.projectsDir)) {
        try {
          for (const projectDir of readdirSync(paths.projectsDir, { withFileTypes: true })) {
            if (!projectDir.isDirectory()) continue;
            const decoded = decodeClaudeProjectDirFull(projectDir.name);
            if (!decoded) continue;
            const projectSlug = decoded.slug;
            const realProjectDir = decoded.realPath;
            const projInv = collectProjectInventory(harness, realProjectDir);
            if (projInv.primitives.length === 0 && projInv.plugins.length === 0) continue;

            const projData = JSON.stringify({
              primitives: projInv.primitives,
              plugins: projInv.plugins,
            });
            const projKey = blobKey(userSlug, harness, projectSlug, "inventory", "primitives.json");
            const projDelta = makeReplaceDelta(projKey, [projData], hashContent(projData), projectSlug, "inventory");
            if (projDelta) deltas.push(projDelta);
          }
        } catch {
          // ignore
        }
      }
    } else if (harness === Harness.GEMINI) {
      const paths = getGeminiHistoryPaths();
      if (existsSync(paths.tmpDir)) {
        try {
          for (const projectDir of readdirSync(paths.tmpDir, { withFileTypes: true })) {
            if (!projectDir.isDirectory()) continue;
            const projPath = join(paths.tmpDir, projectDir.name);
            const projInv = collectProjectInventory(harness, projPath);
            if (projInv.primitives.length === 0 && projInv.plugins.length === 0) continue;

            const projData = JSON.stringify({
              primitives: projInv.primitives,
              plugins: projInv.plugins,
            });
            const projKey = blobKey(userSlug, harness, projectDir.name, "inventory", "primitives.json");
            const projDelta = makeReplaceDelta(projKey, [projData], hashContent(projData), projectDir.name, "inventory");
            if (projDelta) deltas.push(projDelta);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return deltas;
}

// syncHarnessInventory removed — inventory now goes through the normal
// raw_entries delta path (discoverHarnessInventory returns BlobDelta[]).

// ---------------------------------------------------------------------------
// Force clean
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned staging data from a previous interrupted --force.
 */
async function cleanupStaging(
  userSlug: string,
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  await fetch(`${apiUrl}/api/v1/sync?prefix=${encodeURIComponent(userSlug)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {}); // Best effort
}

// commitForce removed — staging commit now handled server-side via finalize flag on last batch POST

/**
 * Run the full sync flow: discover → sanitize → diff → batch upload.
 *
 * When force=true:
 *   1. Clean up orphaned staging from previous interrupted runs
 *   2. Clear local watermarks so all files are re-discovered
 *   3. Upload to staging prefix (production untouched)
 *   4. On success: atomically swap staging → production
 *   5. On failure: staging is orphaned, production still intact
 */
export async function runSync(
  harnesses: Harness[],
  userSlug: string,
  apiUrl: string,
  apiKey: string,
  force = false,
  projectFilter?: ProjectFilter,
  allowedProjects?: Set<string>,
): Promise<SyncResult> {
  if (force) {
    // Clean up any leftover staging from a previous interrupted force
    await cleanupStaging(userSlug, apiUrl, apiKey);

    // Clear local watermarks for the scoped harnesses/projects only
    const watermarks = loadWatermarks();
    let cleared = 0;
    for (const key of Object.keys(watermarks)) {
      if (!key.startsWith(userSlug)) continue;
      // key format: {user}/{harness}/{project}/{logType}/{file}
      const parts = key.split("/");
      const keyHarness = parts[1];
      const keyProject = parts[2];
      // Filter by harness
      if (!harnesses.includes(keyHarness as Harness)) continue;
      // Filter by project (if specified via --projects or allowedProjects)
      if (allowedProjects && allowedProjects.size > 0 && keyProject !== "_global" && !allowedProjects.has(keyProject)) continue;
      delete watermarks[key];
      cleared++;
    }
    if (cleared > 0) {
      saveWatermarks(watermarks);
      process.stderr.write(`Cleared ${cleared} local watermark(s) for force re-sync.\n`);
    }
  }

  const result: SyncResult = {
    filesScanned: 0,
    filesUploaded: 0,
    filesSkipped: 0,
    linesUploaded: 0,
    errors: [],
  };

  // Sync metadata first (always, idempotent)
  const aliases = discoverProjectAliases(harnesses, userSlug);
  if (aliases.length > 0) {
    await syncProjectAliases(aliases, apiUrl, apiKey);
  }
  process.stderr.write(`Discovering deltas for: ${harnesses.join(", ")}\n`);
  const inventoryDeltas = discoverHarnessInventory(harnesses, userSlug);
  const sessionDeltas = discoverDeltas(harnesses, userSlug, projectFilter, allowedProjects);
  const deltas = [...inventoryDeltas, ...sessionDeltas]
    .filter((d) => d.lines.length > 0)
    .filter((d) => d.projectSlug === "_global" || !allowedProjects || allowedProjects.has(d.projectSlug));
  result.filesScanned = deltas.length;

  if (deltas.length === 0) {
    process.stderr.write("No new data to sync.\n");
    return result;
  }

  const totalLines = deltas.reduce((sum, d) => sum + d.lines.length, 0);
  process.stderr.write(`Found ${deltas.length} file(s) with ${totalLines} line(s) to sync.\n`);

  const batches = splitIntoBatches(deltas);
  process.stderr.write(`Uploading in ${batches.length} batch(es)...\n`);

  const UPLOAD_CONCURRENCY = 3;

  function processBatchResult(batch: BlobDelta[], batchResult: IngestResult, batchNum: number) {
    result.filesUploaded += batchResult.ingested;
    if (batchResult.ingested === batch.length) {
      for (const delta of batch) {
        result.linesUploaded += delta.lines.length;
        setWatermark(delta.pendingWatermark.key, delta.pendingWatermark.watermark);
      }
    } else {
      const failedNamespaces = new Set(
        batchResult.errorDetails?.map((e) => e.namespace) ?? [],
      );
      for (const delta of batch) {
        if (failedNamespaces.has(delta.key)) {
          result.errors.push(delta.key);
        } else {
          result.linesUploaded += delta.lines.length;
          setWatermark(delta.pendingWatermark.key, delta.pendingWatermark.watermark);
        }
      }
    }
    process.stderr.write(`  Batch ${batchNum}/${batches.length}: ${batchResult.ingested} ok, ${batchResult.errors} failed\n`);
    if (batchResult.committed) {
      process.stderr.write(`  Committed: archived ${batchResult.committed.archived}, promoted ${batchResult.committed.promoted}\n`);
    }
  }

  // Upload non-final batches in parallel, then send finalize batch last
  if (batches.length > 1) {
    const nonFinalBatches = batches.slice(0, -1);
    // Upload in waves of UPLOAD_CONCURRENCY
    for (let i = 0; i < nonFinalBatches.length; i += UPLOAD_CONCURRENCY) {
      const wave = nonFinalBatches.slice(i, i + UPLOAD_CONCURRENCY);
      const results = await Promise.all(
        wave.map((batch, j) => uploadBatchToServer(batch, apiUrl, apiKey, force, false)
          .then(r => ({ batch, result: r, idx: i + j }))
          .catch(() => ({ batch, result: { ingested: 0, errors: batch.length } as IngestResult, idx: i + j }))
        )
      );
      let aborted = false;
      for (const { batch, result: batchResult, idx } of results) {
        processBatchResult(batch, batchResult, idx + 1);
        if (batchResult.ingested === 0 && batchResult.errors > 0) aborted = true;
      }
      if (aborted) {
        process.stderr.write(`  Aborting: batch failed.\n`);
        for (let j = i + wave.length; j < nonFinalBatches.length; j++) {
          for (const d of nonFinalBatches[j]) result.errors.push(d.key);
        }
        for (const d of batches[batches.length - 1]) result.errors.push(d.key);
        break;
      }
    }
  }

  // Send finalize batch (always last, always sequential)
  if (result.errors.length === 0 || batches.length === 1) {
    const lastBatch = batches[batches.length - 1];
    const batchResult = await uploadBatchToServer(lastBatch, apiUrl, apiKey, force, true);
    processBatchResult(lastBatch, batchResult, batches.length);
  }

  process.stderr.write(
    `Sync complete: ${result.filesUploaded} file(s) uploaded, ${result.linesUploaded} line(s), ${result.errors.length} error(s)\n`,
  );

  return result;
}
