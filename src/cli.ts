#!/usr/bin/env node

import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  buildBatch,
  detectHarnessInstalled,
  filterBatchProjects,
  listProjects,
  serializeBatch,
  type ProjectRow,
} from "./batch.js";
import { Harness, type UploadBatch } from "./models.js";
import { loadConfig, updateConfig, resolveSyncScope, type SyncScope } from "./store.js";
import { discoverDeltas, discoverHarnessInventory, runSync } from "./sync.js";
import { VERSION } from "./version.js";

const ALL_HARNESSES = Object.values(Harness);
const VALID_HARNESS_NAMES = [...ALL_HARNESSES.map((h) => h as string), "all"];

// ---------------------------------------------------------------------------
// Interactive wizard helpers
// ---------------------------------------------------------------------------

function formatProjectRows(rows: ProjectRow[]): string[] {
  const headers = ["PROJECT", "HARNESSES", "SESSIONS", "COMPLETENESS"] as const;
  const data = rows.map((r) => [
    r.name,
    r.harnesses.join(", "),
    String(r.sessionCount),
    r.completeness,
  ]);
  const widths = headers.map((h) => h.length);
  for (const row of data) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  const pad = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);

  const lines: string[] = [
    `${pad(headers[0], widths[0])}  ${pad(headers[1], widths[1])}  ${pad(headers[2], widths[2], true)}  ${pad(headers[3], widths[3])}`,
    `${"-".repeat(widths[0])}  ${"-".repeat(widths[1])}  ${"-".repeat(widths[2])}  ${"-".repeat(widths[3])}`,
  ];
  for (const row of data) {
    lines.push(
      `${pad(row[0], widths[0])}  ${pad(row[1], widths[1])}  ${pad(row[2], widths[2], true)}  ${pad(row[3], widths[3])}`,
    );
  }
  return lines;
}

function parseIndexSelection(text: string, maxIndex: number): number[] {
  const value = text.trim().toLowerCase();
  if (!value || value === "all") {
    return Array.from({ length: maxIndex }, (_, i) => i + 1);
  }
  const selected = new Set<number>();
  for (const part of value.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("-")) {
      const [startStr, endStr] = p.split("-", 2);
      let start = Number(startStr);
      let end = Number(endStr);
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) {
        if (i < 1 || i > maxIndex) {
          throw new Error(`Selection '${p}' is out of range 1-${maxIndex}`);
        }
        selected.add(i);
      }
    } else {
      const idx = Number(p);
      if (idx < 1 || idx > maxIndex) {
        throw new Error(`Selection '${p}' is out of range 1-${maxIndex}`);
      }
      selected.add(idx);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

async function runMultiselectPicker(
  title: string,
  lines: string[],
  selectedDefault: Set<number>,
  footer: string,
  headerLines?: string[],
): Promise<number[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  let current = 0;
  let offset = 0;
  const selected = new Set(selectedDefault);

  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const headerCount = headerLines?.length ?? 0;

  function render() {
    const usableHeight = Math.max(1, rows - (4 + headerCount));
    if (current < offset) offset = current;
    else if (current >= offset + usableHeight) offset = current - usableHeight + 1;

    process.stdout.write("\x1B[2J\x1B[H");
    process.stdout.write(`\x1B[1m${title}\x1B[0m\n`);
    process.stdout.write(`${footer}\n\n`);
    if (headerLines) {
      for (const line of headerLines) {
        process.stdout.write(`\x1B[2m${line}\x1B[0m\n`);
      }
    }

    const visible = lines.slice(offset, offset + usableHeight);
    for (let i = 0; i < visible.length; i++) {
      const actualIdx = offset + i;
      const marker = selected.has(actualIdx) ? "[x]" : "[ ]";
      const row = `${marker} ${visible[i]}`.slice(0, cols - 1);
      if (actualIdx === current) {
        process.stdout.write(`\x1B[7m${row}\x1B[0m\n`);
      } else {
        process.stdout.write(`${row}\n`);
      }
    }
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    render();

    function onData(key: string) {
      if (key === "\x1B[A" || key === "k") current = Math.max(0, current - 1);
      else if (key === "\x1B[B" || key === "j") current = Math.min(lines.length - 1, current + 1);
      else if (key === " ") {
        if (selected.has(current)) selected.delete(current);
        else selected.add(current);
      } else if (key === "a" || key === "A") {
        if (selected.size === lines.length) selected.clear();
        else for (let i = 0; i < lines.length; i++) selected.add(i);
      } else if (key === "\r" || key === "\n") { cleanup(); resolve([...selected].sort((a, b) => a - b)); return; }
      else if (key === "q" || key === "\x1B") { cleanup(); resolve(null); return; }
      render();
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\x1B[2J\x1B[H");
    }

    stdin.on("data", onData);
  });
}

async function fallbackSelectIndexes(
  prompt: string,
  maxIndex: number,
  defaultIndexes: number[],
): Promise<number[]> {
  const defaultText = defaultIndexes.length > 0 ? defaultIndexes.join(",") : "all";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  while (true) {
    let raw = await ask(`${prompt} [default: ${defaultText}]: `);
    raw = raw.trim();
    if (!raw) raw = defaultText;
    try {
      const result = parseIndexSelection(raw, maxIndex);
      rl.close();
      return result;
    } catch (e) {
      process.stdout.write(`Invalid selection: ${e}\n`);
    }
  }
}

async function promptSelectHarnesses(): Promise<Harness[]> {
  const cfg = loadConfig();
  const detected = new Map<Harness, boolean>();
  for (const h of ALL_HARNESSES) detected.set(h, detectHarnessInstalled(h));

  // Default selection from syncScope (if set) or installed harnesses
  const previouslySelected = cfg.syncScope
    ? new Set(ALL_HARNESSES.map((h, i) => i).filter((i) => cfg.syncScope![ALL_HARNESSES[i]] !== false))
    : new Set(ALL_HARNESSES.map((_, i) => i).filter((i) => detected.get(ALL_HARNESSES[i])));

  const lines = ALL_HARNESSES.map(
    (h, i) => `${String(i + 1).padStart(2)}. ${h.padEnd(8)}  ${detected.get(h) ? "installed" : "not detected"}`,
  );

  const picked = await runMultiselectPicker(
    "Select harnesses to scan",
    lines,
    previouslySelected,
    "Arrow keys move, space toggles, a toggles all, enter confirms, q cancels.",
  );

  let indexes: number[];
  if (picked === null) {
    indexes = await fallbackSelectIndexes("Choose harnesses", ALL_HARNESSES.length, [...previouslySelected].map((i) => i + 1));
  } else if (picked.length === 0) {
    return [];
  } else {
    indexes = picked.map((i) => i + 1);
  }

  const result: Harness[] = [];
  const seen = new Set<Harness>();
  for (const idx of indexes) {
    const h = ALL_HARNESSES[idx - 1];
    if (!seen.has(h)) { seen.add(h); result.push(h); }
  }

  // Save to syncScope (will be populated with projects after project selection)
  const scope: SyncScope = {};
  for (const h of ALL_HARNESSES) {
    scope[h] = result.includes(h) ? ["*"] : false;
  }
  updateConfig({ syncScope: scope });
  return result;
}

async function promptSelectProjects(batch: UploadBatch): Promise<Set<string> | null> {
  const cfg = loadConfig();
  const rows = listProjects(batch);
  if (rows.length === 0) return new Set();
  const projects = rows.map((r) => r.name);
  const tableLines = formatProjectRows(rows);
  const bodyLines = tableLines.slice(2);

  // Default: from syncScope project lists, or all
  let previouslySelected: Set<number>;
  if (cfg.syncScope) {
    const scopedProjects = new Set(
      Object.values(cfg.syncScope)
        .filter((v): v is string[] => Array.isArray(v))
        .flat()
        .filter((p) => p !== "*"),
    );
    if (scopedProjects.size > 0) {
      previouslySelected = new Set(projects.map((p, i) => i).filter((i) => scopedProjects.has(projects[i])));
    } else {
      // All harnesses have ["*"] — select all
      previouslySelected = new Set(Array.from({ length: bodyLines.length }, (_, i) => i));
    }
  } else {
    previouslySelected = new Set(Array.from({ length: bodyLines.length }, (_, i) => i));
  }

  const picked = await runMultiselectPicker(
    "Select projects to include",
    bodyLines,
    previouslySelected,
    "Arrow keys move, space toggles, a toggles all, enter confirms, q cancels.",
    tableLines.slice(0, 2),
  );

  let indexes: number[];
  if (picked === null) {
    process.stdout.write("\n");
    for (const line of tableLines) process.stdout.write(`${line}\n`);
    indexes = await fallbackSelectIndexes("Choose projects", projects.length, [...previouslySelected].map((i) => i + 1));
  } else if (picked.length === 0) {
    return null;
  } else {
    indexes = picked.map((i) => i + 1);
  }

  const selected = new Set(indexes.map((i) => projects[i - 1]));

  // Update syncScope with selected projects per harness
  const currentConfig = loadConfig();
  const scope = currentConfig.syncScope ?? {};
  // For each active harness, set project list to the selected projects
  // (We don't know per-project harness mapping here, so set all active harnesses to the selected list)
  for (const h of Object.keys(scope)) {
    if (scope[h] !== false) {
      scope[h] = [...selected];
    }
  }
  updateConfig({ syncScope: scope });

  return selected;
}

async function promptInput(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim();
}

async function promptConfirm(message: string): Promise<boolean> {
  const answer = await promptInput(`${message} [Y/n]: `);
  return ["", "y", "yes"].includes(answer.toLowerCase());
}

function shouldRunWizard(opts: {
  harness: string[];
  projects: string[];
  dryRun: boolean;
  apiKey?: string;
  user?: string;
  listProjects: boolean;
  wizard: boolean;
}): boolean {
  if (!opts.wizard) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  // If user provided enough flags for flag-driven mode, skip wizard
  if (opts.user && opts.apiKey) return false;
  if (opts.harness.length > 0 || opts.projects.length > 0) return false;
  if (opts.listProjects || opts.dryRun) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

async function runInteractiveWizard(opts: {
  apiKey?: string;
  apiUrl: string;
  force: boolean;
}): Promise<number> {
  process.stdout.write(`harnessarena-uploader v${VERSION}\n`);
  const config = loadConfig();

  const harnesses = await promptSelectHarnesses();
  if (harnesses.length === 0) {
    process.stdout.write("Wizard canceled.\n");
    return 0;
  }

  process.stderr.write(`\nScanning: ${harnesses.join(", ")}\n`);

  const batch = buildBatch(harnesses);
  if (batch === null) {
    process.stderr.write("No sessions found.\n");
    return 0;
  }

  const selectedProjects = await promptSelectProjects(batch);
  if (selectedProjects === null) {
    process.stdout.write("Wizard canceled.\n");
    return 0;
  }
  if (selectedProjects.size === 0) {
    process.stderr.write("No named projects found.\n");
    return 0;
  }

  const filteredBatch = filterBatchProjects(batch, selectedProjects);
  if (filteredBatch === null) {
    process.stderr.write("No sessions left after project selection.\n");
    return 0;
  }

  process.stdout.write("\nFinal selection:\n\n");
  for (const line of formatProjectRows(listProjects(filteredBatch))) {
    process.stdout.write(`${line}\n`);
  }

  // Resolve API key
  let apiKey = opts.apiKey || config.apiKey;
  if (!apiKey) {
    apiKey = await promptInput("\nHarness Arena API key: ");
    if (apiKey) updateConfig({ apiKey });
  }
  if (!apiKey) {
    process.stderr.write("Error: API key is required.\n");
    return 1;
  }

  // Resolve user slug
  let userSlug = config.userSlug;
  if (!userSlug) {
    userSlug = await promptInput("Username: ");
    if (!userSlug) {
      process.stderr.write("Error: username is required.\n");
      return 1;
    }
    updateConfig({ userSlug });
  }

  // Save API URL if non-default
  if (opts.apiUrl !== "https://harnessarena.com") {
    updateConfig({ apiUrl: opts.apiUrl });
  }

  // Confirm and sync
  const deltas = discoverDeltas(harnesses, userSlug);
  const totalLines = deltas.reduce((sum, d) => sum + d.lines.length, 0);

  if (totalLines === 0) {
    process.stdout.write("\nNo new data to sync.\n");
    return 0;
  }

  process.stdout.write(`\n${deltas.length} file(s), ${totalLines} line(s) to sync.\n`);
  if (!(await promptConfirm(`Sync to ${opts.apiUrl}?`))) {
    process.stdout.write("Sync canceled.\n");
    return 0;
  }

  const result = await runSync(harnesses, userSlug, opts.apiUrl, apiKey, opts.force);
  return result.errors.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const program = new Command();

  program
    .name("harnessarena-uploader")
    .description(
      "Sync AI coding harness session metadata to harnessarena.com",
    )
    .addHelpText(
      "after",
      "\nPrivacy: This tool NEVER reads or transmits message content, code, or file paths.",
    )
    .version(`harnessarena-uploader ${VERSION}`, "--version");

  program
    .option(
      "--harness <name>",
      "Which harnesses to scan. Can repeat. Default: all.",
      (val: string, prev: string[]) => {
        if (!VALID_HARNESS_NAMES.includes(val)) {
          program.error(`error: option '--harness' must be one of: ${VALID_HARNESS_NAMES.join(", ")}`);
        }
        prev.push(val);
        return prev;
      },
      [] as string[],
    )
    .option("--dry-run", "Extract and print deltas without uploading", false)
    .option("--api-key <key>", "API key (or set HARNESSARENA_API_KEY)", process.env.HARNESSARENA_API_KEY || config.apiKey)
    .option("--api-url <url>", "API base URL", process.env.HARNESSARENA_API_URL || config.apiUrl || "https://harnessarena.com")
    .option("--user <slug>", "User slug", config.userSlug)
    .option(
      "--projects <name>",
      "Which projects to sync. Can repeat. Default: all (or from syncScope config).",
      (val: string, prev: string[]) => { prev.push(val); return prev; },
      [] as string[],
    )
    .option("--list-projects", "List unique projects and exit.", false)
    .option("-W, --no-wizard", "Disable the interactive wizard.")
    .option("--force", "Force re-sync: stage new data, then atomically swap with old.", false);

  program.parse();
  const opts = program.opts<{
    harness: string[];
    projects: string[];
    dryRun: boolean;
    apiKey?: string;
    apiUrl: string;
    user?: string;
    listProjects: boolean;
    wizard: boolean;
    force: boolean;
  }>();

  // Wizard mode: interactive when no flags are passed
  if (shouldRunWizard(opts)) {
    const code = await runInteractiveWizard(opts);
    process.exit(code);
  }

  // --- Flag-driven mode ---

  // Resolve sync scope from config + CLI flags
  const { harnesses, projectFilter } = resolveSyncScope(
    ALL_HARNESSES,
    config,
    opts.harness.includes("all") ? [] : opts.harness,
    opts.projects,
  );

  // Build allowed projects set for history line filtering
  const allowedProjects = new Set<string>();
  if (opts.projects.length > 0) {
    opts.projects.forEach((p: string) => allowedProjects.add(p));
  } else if (config.syncScope) {
    for (const projects of Object.values(config.syncScope)) {
      if (Array.isArray(projects)) projects.forEach((p) => allowedProjects.add(p));
    }
  }

  if (harnesses.length === 0) {
    process.stderr.write("No harnesses to scan.\n");
    process.exit(0);
  }

  // Require user slug
  if (!opts.user) {
    process.stderr.write("Error: --user is required\n");
    process.exit(1);
  }

  // Require API key
  if (!opts.apiKey) {
    process.stderr.write("Error: --api-key required (or set HARNESSARENA_API_KEY env var)\n");
    process.exit(1);
  }

  process.stderr.write(`harnessarena-uploader v${VERSION}\n`);
  process.stderr.write(`Scanning: ${harnesses.join(", ")}\n`);
  if (opts.projects.length > 0) {
    process.stderr.write(`Projects: ${opts.projects.join(", ")}\n`);
  }

  // List projects mode
  if (opts.listProjects) {
    const batch = buildBatch(harnesses as Harness[]);
    if (batch === null) {
      process.stderr.write("No sessions found.\n");
      process.exit(0);
    }
    const projects = listProjects(batch);
    if (projects.length === 0) {
      process.stdout.write("No named projects found.\n");
      process.exit(0);
    }
    for (const line of formatProjectRows(projects)) {
      process.stdout.write(`${line}\n`);
    }
    process.exit(0);
  }

  // Dry run
  if (opts.dryRun && !opts.force) {
    const inventoryDeltas = discoverHarnessInventory(harnesses as Harness[], opts.user);
    const sessionDeltas = discoverDeltas(harnesses as Harness[], opts.user, projectFilter, allowedProjects.size > 0 ? allowedProjects : undefined);
    const deltas = [...inventoryDeltas, ...sessionDeltas];
    const totalLines = deltas.reduce((sum, d) => sum + d.lines.length, 0);
    if (totalLines === 0) {
      process.stderr.write("No new data to sync.\n");
      process.exit(0);
    }
    process.stderr.write("\n--- DRY RUN: deltas below ---\n\n");
    for (const d of deltas) {
      process.stdout.write(`${d.mode} ${d.key} (${d.lines.length} lines, offset=${d.lineOffset})\n`);
    }
    process.exit(0);
  }

  // Sync (default action)
  const result = await runSync(harnesses as Harness[], opts.user, opts.apiUrl, opts.apiKey, opts.force, projectFilter, allowedProjects.size > 0 ? allowedProjects : undefined);
  process.exit(result.errors.length === 0 ? 0 : 1);
}

main();
