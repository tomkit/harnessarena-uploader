#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { detectHarnessInstalled } from "./batch.js";
import { Harness } from "./models.js";
import {
  loadConfig,
  loadWatermarks,
  resolveSyncScope,
  setDevMode,
  setIgnoreWatermarks,
  isDevMode,
  updateConfig,
  type SyncScope,
  type AppendWatermark,
} from "./store.js";
import {
  discoverDeltas,
  discoverProjects,
  runSync,
  type BlobDelta,
  type ProjectFilter,
} from "./sync.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Only scan supported harnesses (gemini, cursor, opencode not yet supported)
const ALL_HARNESSES = [Harness.CLAUDE, Harness.CODEX];
const VALID_HARNESS_NAMES = [...ALL_HARNESSES.map((h) => h as string), "all"];
const PROD_URL = "https://www.harnessarena.ai";
const DEV_URL = "http://localhost:3000";

/** Detect --dev/-d early (before commander parses) and set dev mode globally. */
function initDevMode(): void {
  const dev = process.argv.includes("--dev") || process.argv.includes("-d") || process.env.HARNESSARENA_DEV === "1";
  setDevMode(dev);
}

function apiUrl(): string {
  return isDevMode() ? DEV_URL : PROD_URL;
}

function hasConfig(): boolean {
  const file = isDevMode() ? "config.local.json" : "config.json";
  return existsSync(join(homedir(), ".harnessarena", file));
}

// ---------------------------------------------------------------------------
// Project discovery from deltas
// ---------------------------------------------------------------------------

interface ProjectRow {
  name: string;
  harnesses: string[];
  fileCount: number;
}

function listProjectsFromDeltas(deltas: BlobDelta[]): ProjectRow[] {
  const projects = new Map<
    string,
    { harnesses: Set<string>; fileCount: number }
  >();
  for (const d of deltas) {

    let entry = projects.get(d.projectSlug);
    if (!entry) {
      entry = { harnesses: new Set(), fileCount: 0 };
      projects.set(d.projectSlug, entry);
    }
    const harness = d.key.split("/")[1];
    if (harness) entry.harnesses.add(harness);
    entry.fileCount++;
  }
  return [...projects.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, entry]) => ({
      name,
      harnesses: [...entry.harnesses].sort(),
      fileCount: entry.fileCount,
    }));
}

function formatProjectRows(rows: ProjectRow[]): string[] {
  const headers = ["PROJECT", "HARNESSES", "FILES"] as const;
  const data = rows.map((r) => [
    r.name,
    r.harnesses.join(", "),
    String(r.fileCount),
  ]);
  const widths = headers.map((h) => h.length);
  for (const row of data) {
    for (let i = 0; i < row.length; i++)
      widths[i] = Math.max(widths[i], row[i].length);
  }
  const pad = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);
  const lines: string[] = [
    `${pad(headers[0], widths[0])}  ${pad(headers[1], widths[1])}  ${pad(headers[2], widths[2], true)}`,
    `${"-".repeat(widths[0])}  ${"-".repeat(widths[1])}  ${"-".repeat(widths[2])}`,
  ];
  for (const row of data) {
    lines.push(
      `${pad(row[0], widths[0])}  ${pad(row[1], widths[1])}  ${pad(row[2], widths[2], true)}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Interactive wizard helpers
// ---------------------------------------------------------------------------

async function runMultiselectPicker(
  title: string,
  lines: string[],
  selectedDefault: Set<number>,
  footer: string,
  headerLines?: string[],
): Promise<number[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  let current = 0,
    offset = 0;
  const selected = new Set(selectedDefault);
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const headerCount = headerLines?.length ?? 0;

  function render() {
    const usableHeight = Math.max(1, rows - (4 + headerCount));
    if (current < offset) offset = current;
    else if (current >= offset + usableHeight)
      offset = current - usableHeight + 1;
    process.stdout.write("\x1B[2J\x1B[H");
    process.stdout.write(`\x1B[1m${title}\x1B[0m\n${footer}\n\n`);
    if (headerLines)
      for (const line of headerLines)
        process.stdout.write(`\x1B[2m${line}\x1B[0m\n`);
    const visible = lines.slice(offset, offset + usableHeight);
    for (let i = 0; i < visible.length; i++) {
      const actualIdx = offset + i;
      const marker = selected.has(actualIdx) ? "[x]" : "[ ]";
      const row = `${marker} ${visible[i]}`.slice(0, cols - 1);
      process.stdout.write(
        actualIdx === current ? `\x1B[7m${row}\x1B[0m\n` : `${row}\n`,
      );
    }
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    render();
    function onData(key: string) {
      if (key === "\x03") {
        cleanup();
        process.exit(130);
      } // Ctrl+C: hard exit
      else if (key === "\x1B[A" || key === "k")
        current = Math.max(0, current - 1);
      else if (key === "\x1B[B" || key === "j")
        current = Math.min(lines.length - 1, current + 1);
      else if (key === " ") {
        if (selected.has(current)) selected.delete(current);
        else selected.add(current);
      } else if (key === "a" || key === "A") {
        if (selected.size === lines.length) selected.clear();
        else for (let i = 0; i < lines.length; i++) selected.add(i);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve([...selected].sort((a, b) => a - b));
        return;
      } else if (key === "q" || (key === "\x1B" && key.length === 1)) {
        cleanup();
        resolve(null);
        return;
      } // q or Esc: cancel picker
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

async function promptInput(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answered = false;
  const answer = await new Promise<string>((resolve) => {
    rl.on("close", () => {
      if (!answered) {
        process.stdout.write("\n");
        process.exit(130);
      }
    });
    rl.question(prompt, (a) => {
      answered = true;
      resolve(a);
    });
  });
  rl.close();
  return answer.trim();
}

async function promptConfirm(message: string): Promise<boolean> {
  const answer = await promptInput(`${message} [Y/n]: `);
  return ["", "y", "yes"].includes(answer.toLowerCase());
}

// ---------------------------------------------------------------------------
// Login — device auth flow
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    // User will need to manually navigate
  }
}

/**
 * Device auth flow per RFC 8628:
 * 1. Server generates device_code (secret, for polling) + user_code (short, user types in browser)
 * 2. CLI displays user_code, opens browser to verification URI
 * 3. User signs in via GitHub, types user_code to approve
 * 4. CLI polls with device_code, receives API key on approval
 */
async function runLogin(
  apiUrl: string,
): Promise<{ apiKey: string; userSlug: string } | null> {
  let registerRes: Response;
  try {
    registerRes = await fetch(`${apiUrl}/api/auth/device`, { method: "POST" });
  } catch (e) {
    process.stderr.write(
      `Cannot reach ${apiUrl}: ${e instanceof Error ? e.message : e}\n`,
    );
    return null;
  }

  if (!registerRes.ok) {
    const body = await registerRes
      .json()
      .catch(() => ({ error: "Unknown error" }));
    process.stderr.write(`Error: ${(body as Record<string, string>).error}\n`);
    return null;
  }

  const reg = (await registerRes.json()) as Record<string, string>;
  const deviceCode = reg.device_code;
  const userCode = reg.user_code;
  const verificationUrl = `${apiUrl}${reg.verification_uri}`;

  process.stdout.write(`\nEnter this code in your browser:\n\n`);
  process.stdout.write(`  ${userCode}\n\n`);
  process.stdout.write(`Opening ${verificationUrl}\n`);
  process.stdout.write(
    `(If it doesn't open, visit the URL and enter the code.)\n\n`,
  );
  openBrowser(verificationUrl);

  process.stdout.write("Waiting for approval...");
  const pollUrl = `${apiUrl}/api/auth/device/poll?code=${deviceCode}`;

  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(pollUrl);
      if (!res.ok) {
        process.stdout.write(".");
        continue;
      }

      const body = (await res.json()) as Record<string, unknown>;
      if (body.status === "approved" && body.api_key) {
        const apiKey = body.api_key as string;
        const userSlug = (body.username as string) || "unknown";
        process.stdout.write(` done!\n\nLogged in as @${userSlug}\n`);
        updateConfig({ apiKey, userSlug });
        return { apiKey, userSlug };
      }
      process.stdout.write(".");
    } catch {
      process.stdout.write(".");
    }
  }

  process.stdout.write("\nTimed out waiting for approval.\n");
  return null;
}

/**
 * Ensure the user is logged in. If not, run the login flow.
 * Returns { apiKey, userSlug } or exits.
 */
async function ensureAuth(
  apiUrl: string,
): Promise<{ apiKey: string; userSlug: string }> {
  const config = loadConfig();
  const apiKey = config.apiKey;
  const userSlug = config.userSlug;

  if (apiKey && userSlug) {
    return { apiKey, userSlug };
  }

  // Need to log in
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Error: not logged in. Run 'harnessarena-uploader login' first.\n",
    );
    process.exit(1);
  }

  process.stdout.write("No account found. Let's sign you in.\n");
  const result = await runLogin(apiUrl);
  if (!result) {
    process.exit(1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

async function runInteractiveWizard(
  apiUrl: string,
  auth: { apiKey: string; userSlug: string },
  opts: { force: boolean },
): Promise<number> {
  const cfg = loadConfig();

  // 1. Harness selection
  const detected = new Map<Harness, boolean>();
  for (const h of ALL_HARNESSES) detected.set(h, detectHarnessInstalled(h));

  const harnessDefault = cfg.syncScope
    ? new Set(
        ALL_HARNESSES.map((h, i) => i).filter(
          (i) => cfg.syncScope![ALL_HARNESSES[i]] !== false,
        ),
      )
    : new Set(
        ALL_HARNESSES.map((_, i) => i).filter((i) =>
          detected.get(ALL_HARNESSES[i]),
        ),
      );

  const harnessLines = ALL_HARNESSES.map(
    (h, i) =>
      `${String(i + 1).padStart(2)}. ${h.padEnd(8)}  ${detected.get(h) ? "installed" : "not detected"}`,
  );

  const harnessPicked = await runMultiselectPicker(
    "Select harnesses to scan",
    harnessLines,
    harnessDefault,
    "Arrow keys move, space toggles, a toggles all, enter confirms, q cancels.",
  );

  if (harnessPicked === null || harnessPicked.length === 0) {
    if (await promptConfirm("Continue?")) {
      return runInteractiveWizard(apiUrl, auth, opts); // restart
    }
    return 0;
  }
  const harnessIndexes = harnessPicked.map((i) => i + 1);

  const harnesses: Harness[] = [];
  const seen = new Set<Harness>();
  for (const idx of harnessIndexes) {
    const h = ALL_HARNESSES[idx - 1];
    if (!seen.has(h)) {
      seen.add(h);
      harnesses.push(h);
    }
  }

  // 2. Discover all projects on disk
  process.stderr.write(`\nScanning: ${harnesses.join(", ")}\n`);
  const allProjects = discoverProjects(harnesses);

  if (allProjects.length === 0) {
    process.stderr.write("No projects found.\n");
    return 0;
  }

  // Dedupe project names (may appear under multiple harnesses)
  const uniqueProjects = [...new Set(allProjects.map((p) => p.name))].sort();
  const projectHarnesses = new Map<string, Set<string>>();
  const projectPaths = new Map<string, string>();
  const projectManifestNames = new Map<string, string>();
  for (const p of allProjects) {
    if (!projectHarnesses.has(p.name)) projectHarnesses.set(p.name, new Set());
    projectHarnesses.get(p.name)!.add(p.harness);
    if (p.path && !projectPaths.has(p.name)) projectPaths.set(p.name, p.path);
    if (p.manifestName && !projectManifestNames.has(p.name))
      projectManifestNames.set(p.name, p.manifestName);
  }

  process.stderr.write(`Found ${uniqueProjects.length} project(s):\n\n`);
  const hasAnyManifestDiff = projectManifestNames.size > 0;
  const termCols = process.stdout.columns || 80;
  const foundHeaders = hasAnyManifestDiff
    ? ["PROJECT", "HARNESSES", "PATH", "MANIFEST NAME"]
    : ["PROJECT", "HARNESSES", "PATH"];

  // Compute column widths, but cap PATH to fit the terminal
  const nameWidth = Math.max(foundHeaders[0].length, ...uniqueProjects.map((n) => n.length));
  const harnessWidth = Math.max(foundHeaders[1].length, ...uniqueProjects.map((n) => [...projectHarnesses.get(n)!].sort().join(", ").length));
  const fixedWidth = 2 + nameWidth + 2 + harnessWidth + 2; // indent + cols + gaps
  const manifestWidth = hasAnyManifestDiff ? Math.max(foundHeaders[3].length, ...[...projectManifestNames.values()].map((v) => v.length)) + 2 : 0;
  const maxPath = Math.max(10, termCols - fixedWidth - manifestWidth);

  function truncPath(p: string, max: number): string {
    if (p.length <= max) return p;
    return "..." + p.slice(p.length - max + 3);
  }

  const foundData = uniqueProjects.map((name) => {
    const row = [
      name,
      [...projectHarnesses.get(name)!].sort().join(", "),
      truncPath(projectPaths.get(name) ?? "", maxPath),
    ];
    if (hasAnyManifestDiff) row.push(projectManifestNames.get(name) ?? "");
    return row;
  });
  const foundWidths = foundHeaders.map((h) => h.length);
  for (const row of foundData) {
    for (let i = 0; i < row.length; i++)
      foundWidths[i] = Math.max(foundWidths[i], row[i].length);
  }
  const pad = (s: string, w: number) => s.padEnd(w);
  process.stderr.write(`  ${foundHeaders.map((h, i) => pad(h, foundWidths[i])).join("  ")}\n`);
  process.stderr.write(`  ${foundWidths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of foundData)
    process.stderr.write(`  ${row.map((c, i) => pad(c, foundWidths[i])).join("  ")}\n`);
  process.stderr.write("\n");

  // 3. Project selection (show manifest name inline if it differs)
  const cols = process.stdout.columns || 80;

  // Compute label width (project name + optional manifest suffix)
  const labelWidth = Math.max(...uniqueProjects.map((name) => {
    const manifest = projectManifestNames.get(name);
    return manifest ? name.length + manifest.length + 3 : name.length; // " (manifest)"
  }));
  const prefixLen = 6; // "[x] " + padding
  const pickerFixedLen = prefixLen + labelWidth + 2 + foundWidths[1] + 2;
  const maxPathLen = Math.max(10, cols - pickerFixedLen);

  function truncatePath(p: string, max: number): string {
    if (p.length <= max) return p;
    return "..." + p.slice(p.length - max + 3);
  }

  const projLines = uniqueProjects.map((name) => {
    const h = [...projectHarnesses.get(name)!].sort().join(", ");
    const rawPath = projectPaths.get(name) ?? "";
    const manifest = projectManifestNames.get(name);
    const label = manifest ? `${name} (${manifest})` : name;
    const p = truncatePath(rawPath, maxPathLen);
    return `${label.padEnd(labelWidth)}  ${h.padEnd(foundWidths[1])}  ${p}`;
  });

  let projDefault: Set<number>;
  if (cfg.syncScope) {
    const scopedProjects = new Set(
      Object.values(cfg.syncScope)
        .filter((v): v is string[] => Array.isArray(v))
        .flat()
        .filter((p) => p !== "*"),
    );
    projDefault =
      scopedProjects.size > 0
        ? new Set(
            uniqueProjects
              .map((_, i) => i)
              .filter((i) => scopedProjects.has(uniqueProjects[i])),
          )
        : new Set(Array.from({ length: uniqueProjects.length }, (_, i) => i));
  } else {
    projDefault = new Set(
      Array.from({ length: uniqueProjects.length }, (_, i) => i),
    );
  }

  const projPicked = await runMultiselectPicker(
    "Select projects to sync",
    projLines,
    projDefault,
    "Arrow keys move, space toggles, a toggles all, enter confirms, q cancels.",
  );

  if (projPicked === null || projPicked.length === 0) {
    if (await promptConfirm("Continue?")) {
      return runInteractiveWizard(apiUrl, auth, opts); // restart
    }
    return 0;
  }
  const projIndexes = projPicked.map((i) => i + 1);

  const selectedProjects = new Set(
    projIndexes.map((i) => uniqueProjects[i - 1]),
  );

  // Detect previously synced projects that were deselected
  const previouslyScoped = new Set(
    Object.values(cfg.syncScope ?? {})
      .filter((v): v is string[] => Array.isArray(v))
      .flat()
      .filter((p) => p !== "*"),
  );
  const deselected = [...previouslyScoped].filter(
    (p) => !selectedProjects.has(p),
  );
  if (deselected.length > 0) {
    process.stderr.write(
      `\nNote: ${deselected.length} previously synced project(s) deselected and will no longer sync:\n`,
    );
    for (const p of deselected.sort()) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(
      `Tip: To remove them from your profile, visit ${apiUrl} and delete from the UI.\n`,
    );
  }

  // 4. Show sync status per selected project
  process.stderr.write(
    `\nSelected ${selectedProjects.size} project(s). Checking sync status...\n`,
  );
  const allDeltas = discoverDeltas(harnesses, auth.userSlug, undefined, selectedProjects);

  // Build per-project sync status
  const projectNewLines = new Map<string, number>();
  const projectNewFiles = new Map<string, number>();
  for (const d of allDeltas) {

    projectNewLines.set(
      d.projectSlug,
      (projectNewLines.get(d.projectSlug) ?? 0) + d.lines.length,
    );
    projectNewFiles.set(
      d.projectSlug,
      (projectNewFiles.get(d.projectSlug) ?? 0) + 1,
    );
  }

  process.stderr.write("\n");
  const statusHeaders = ["PROJECT", "HARNESSES", "STATUS"] as const;
  const statusData = [...selectedProjects].sort().map((name) => {
    const newLines = projectNewLines.get(name) ?? 0;
    const newFiles = projectNewFiles.get(name) ?? 0;
    const status =
      newLines > 0
        ? `${newFiles} file(s), ${newLines} new line(s)`
        : "up to date";
    return [
      name,
      [...(projectHarnesses.get(name) ?? [])].sort().join(", "),
      status,
    ];
  });
  const statusWidths = statusHeaders.map((h) => h.length);
  for (const row of statusData) {
    for (let i = 0; i < row.length; i++)
      statusWidths[i] = Math.max(statusWidths[i], row[i].length);
  }
  process.stderr.write(
    `  ${pad(statusHeaders[0], statusWidths[0])}  ${pad(statusHeaders[1], statusWidths[1])}  ${statusHeaders[2]}\n`,
  );
  process.stderr.write(
    `  ${"-".repeat(statusWidths[0])}  ${"-".repeat(statusWidths[1])}  ${"-".repeat(statusWidths[2])}\n`,
  );
  for (const row of statusData)
    process.stderr.write(
      `  ${pad(row[0], statusWidths[0])}  ${pad(row[1], statusWidths[1])}  ${row[2]}\n`,
    );

  const totalLines = allDeltas.reduce((sum, d) => sum + d.lines.length, 0);
  if (totalLines === 0) {
    process.stderr.write("\nAll selected projects are up to date.\n");
    return 0;
  }

  process.stderr.write(
    `\n${allDeltas.length} file(s), ${totalLines} line(s) to sync.\n`,
  );
  if (!(await promptConfirm(`Sync to ${apiUrl}?`))) {
    process.stdout.write("Sync canceled.\n");
    return 0;
  }

  // Save scope — written only after user confirms sync
  const newScope: SyncScope = {};
  for (const h of ALL_HARNESSES) {
    newScope[h] = harnesses.includes(h) ? [...selectedProjects] : false;
  }
  updateConfig({ syncScope: newScope });

  const result = await runSync(
    harnesses,
    auth.userSlug,
    apiUrl,
    auth.apiKey,
    opts.force,
    undefined,
    selectedProjects.size > 0 ? selectedProjects : undefined,
  );
  return result.errors.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Force sync preview
// ---------------------------------------------------------------------------

/**
 * Preview what --force would do: discover all local data (ignoring watermarks),
 * compare client line counts vs server (from watermarks) to detect pruning.
 */
async function previewAndConfirmForce(
  harnesses: Harness[],
  auth: { apiKey: string; userSlug: string },
  url: string,
  projectFilter?: ProjectFilter,
  allowedProjects?: Set<string>,
): Promise<number> {
  // 1. Get server-side line counts from watermarks
  const watermarks = loadWatermarks();
  const serverLines = new Map<string, number>();
  const serverHarnesses = new Map<string, Set<string>>();
  for (const [key, wm] of Object.entries(watermarks)) {
    if (!key.startsWith(auth.userSlug + "/")) continue;
    const parts = key.split("/");
    const keyHarness = parts[1];
    const keyProject = parts[2];
    if (keyProject.startsWith("_")) continue;
    if (!harnesses.includes(keyHarness as Harness)) continue;
    if (allowedProjects && allowedProjects.size > 0 && !allowedProjects.has(keyProject)) continue;
    if (wm.mode === "append") {
      serverLines.set(keyProject, (serverLines.get(keyProject) ?? 0) + (wm as AppendWatermark).totalLinesUploaded);
    }
    if (!serverHarnesses.has(keyProject)) serverHarnesses.set(keyProject, new Set());
    serverHarnesses.get(keyProject)!.add(keyHarness);
  }

  // 2. Get client-side line counts by discovering deltas with watermarks ignored
  setIgnoreWatermarks(true);
  const clientDeltas = discoverDeltas(harnesses, auth.userSlug, projectFilter, allowedProjects && allowedProjects.size > 0 ? allowedProjects : undefined);
  setIgnoreWatermarks(false);

  const clientLines = new Map<string, number>();
  const clientHarnesses = new Map<string, Set<string>>();
  for (const d of clientDeltas) {
    clientLines.set(d.projectSlug, (clientLines.get(d.projectSlug) ?? 0) + d.lines.length);
    const harness = d.key.split("/")[1];
    if (!clientHarnesses.has(d.projectSlug)) clientHarnesses.set(d.projectSlug, new Set());
    if (harness) clientHarnesses.get(d.projectSlug)!.add(harness);
  }

  // 3. Merge all project names
  const allNames = [...new Set([...serverLines.keys(), ...clientLines.keys()])].sort();
  if (allNames.length === 0) {
    process.stderr.write("No projects found.\n");
    return 0;
  }

  // 4. Build display
  const pad = (s: string, w: number) => s.padEnd(w);
  const rpad = (s: string, w: number) => s.padStart(w);

  process.stderr.write("\n--- FORCE SYNC PREVIEW ---\n\n");
  process.stderr.write("This will replace ALL server data for the selected harnesses/projects.\n\n");

  const headers = ["PROJECT", "HARNESSES", "CLIENT", "SERVER", ""];
  const data = allNames.map((name) => {
    const cLines = clientLines.get(name) ?? 0;
    const sLines = serverLines.get(name) ?? 0;
    const h = [...new Set([...(clientHarnesses.get(name) ?? []), ...(serverHarnesses.get(name) ?? [])])].sort().join(", ");
    let note = "";
    if (sLines === 0) note = "new";
    else if (cLines === 0) note = "SERVER ONLY — will be archived";
    else if (cLines < sLines) note = `pruned (${sLines - cLines} lines lost)`;
    else if (cLines === sLines) note = "unchanged";
    else note = `+${cLines - sLines} new lines`;
    return [name, h, String(cLines), String(sLines), note];
  });
  const widths = headers.map((h) => h.length);
  for (const row of data) { for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length); }

  process.stderr.write(`  ${pad(headers[0], widths[0])}  ${pad(headers[1], widths[1])}  ${rpad(headers[2], widths[2])}  ${rpad(headers[3], widths[3])}  ${headers[4]}\n`);
  process.stderr.write(`  ${"-".repeat(widths[0])}  ${"-".repeat(widths[1])}  ${"-".repeat(widths[2])}  ${"-".repeat(widths[3])}  ${"-".repeat(widths[4])}\n`);
  for (const row of data) {
    process.stderr.write(`  ${pad(row[0], widths[0])}  ${pad(row[1], widths[1])}  ${rpad(row[2], widths[2])}  ${rpad(row[3], widths[3])}  ${row[4]}\n`);
  }

  // Highlight pruning warnings
  const pruned = data.filter((r) => r[4].startsWith("pruned") || r[4].startsWith("SERVER ONLY"));
  if (pruned.length > 0) {
    process.stderr.write("\nWarning: Some projects have more data on the server than locally.\n");
    process.stderr.write("Force sync will replace server data with local data. Lost lines\n");
    process.stderr.write("cannot be recovered if the harness pruned the local logs.\n");
  }

  process.stderr.write("\n");
  if (!(await promptConfirm("Proceed with force sync?"))) {
    process.stdout.write("Force sync canceled.\n");
    return 0;
  }

  const result = await runSync(harnesses, auth.userSlug, url, auth.apiKey, true, projectFilter, allowedProjects && allowedProjects.size > 0 ? allowedProjects : undefined);
  return result.errors.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  initDevMode();
  const program = new Command();

  program
    .name("harnessarena-uploader")
    .description(
      "Sync AI coding harness session metadata to Harness Arena.\nOnly aggregated metrics are uploaded by default; raw session content requires full-data mode.\nAll uploaded data can be exported or permanently deleted at any time.",
    )
    .version(VERSION, "-v, --version");

  // --- login ---
  program
    .command("login")
    .description("Sign in via browser (GitHub OAuth)")
    .option("-d, --dev", "Use local dev server (localhost:3000)", false)
    .action(async () => {
      const result = await runLogin(apiUrl());
      process.exit(result ? 0 : 1);
    });

  // --- logout ---
  program
    .command("logout")
    .description("Remove saved API key and sign out")
    .option("-d, --dev", "Use local dev server (localhost:3000)", false)
    .action(async () => {
      updateConfig({ apiKey: undefined, userSlug: undefined });
      process.stdout.write("Logged out. API key removed.\n");
      process.exit(0);
    });

  // --- sync (default command) ---
  program
    .command("sync", { isDefault: true })
    .description("Sync session metadata to Harness Arena")
    .option("-H, --harness <name>", "Harnesses to scan (repeatable)",
      (val: string, prev: string[]) => {
        if (!VALID_HARNESS_NAMES.includes(val)) program.error(`'--harness' must be one of: ${VALID_HARNESS_NAMES.join(", ")}`);
        prev.push(val); return prev;
      }, [] as string[])
    .option("-p, --projects <name>", "Projects to sync (repeatable)",
      (val: string, prev: string[]) => { prev.push(val); return prev; }, [] as string[])
    .option("-d, --dev", "Use local dev server (localhost:3000)", false)
    .option("-n, --dry-run", "Show what would sync without uploading", false)
    .option("-l, --list-projects", "List discovered projects and exit", false)
    .option("-i, --interactive", "Run the interactive wizard", false)
    .option("-f, --force", "Force re-sync: stage then atomically swap", false)
    .action(async (opts: {
      harness: string[];
      projects: string[];
      dryRun: boolean;
      listProjects: boolean;
      interactive: boolean;
      force: boolean;
    }) => {
      const url = apiUrl();
      const config = loadConfig();
      process.stderr.write(`harnessarena-uploader v${VERSION}\n`);

      const firstRun = !hasConfig() && process.stdin.isTTY && process.stdout.isTTY;
      const auth = await ensureAuth(url);

      if (firstRun || (opts.interactive && process.stdin.isTTY && process.stdout.isTTY)) {
        const code = await runInteractiveWizard(url, auth, opts);
        process.exit(code);
      }

      // --- Headless mode ---
      const { harnesses, projectFilter } = resolveSyncScope(
        ALL_HARNESSES, config,
        opts.harness.includes("all") ? [] : opts.harness,
        opts.projects,
      );

      const allowedProjects = new Set<string>();
      if (opts.projects.length > 0) {
        opts.projects.forEach((p) => allowedProjects.add(p));
      } else if (config.syncScope) {
        for (const projects of Object.values(config.syncScope)) {
          if (Array.isArray(projects)) projects.forEach((p) => allowedProjects.add(p));
        }
      }

      if (harnesses.length === 0) { process.stderr.write("No harnesses to scan.\n"); process.exit(0); }

      process.stderr.write(`Scanning: ${harnesses.join(", ")}\n`);
      if (opts.projects.length > 0) process.stderr.write(`Projects: ${opts.projects.join(", ")}\n`);

      // List projects
      if (opts.listProjects) {
        const localProjects = discoverProjects(harnesses as Harness[]);
        if (localProjects.length === 0) { process.stdout.write("No projects found.\n"); process.exit(0); }
        const names = [...new Set(localProjects.map((p) => p.name))].sort();
        const projHarnesses = new Map<string, Set<string>>();
        const projPaths = new Map<string, string>();
        const projManifest = new Map<string, string>();
        for (const lp of localProjects) {
          if (!projHarnesses.has(lp.name)) projHarnesses.set(lp.name, new Set());
          projHarnesses.get(lp.name)!.add(lp.harness);
          if (lp.path && !projPaths.has(lp.name)) projPaths.set(lp.name, lp.path);
          if (lp.manifestName && !projManifest.has(lp.name)) projManifest.set(lp.name, lp.manifestName);
        }
        const hasManifest = projManifest.size > 0;
        const headers = hasManifest ? ["PROJECT", "HARNESSES", "PATH", "MANIFEST NAME"] : ["PROJECT", "HARNESSES", "PATH"];
        const data = names.map((n) => {
          const row = [n, [...projHarnesses.get(n)!].sort().join(", "), projPaths.get(n) ?? ""];
          if (hasManifest) row.push(projManifest.get(n) ?? "");
          return row;
        });
        const widths = headers.map((h) => h.length);
        for (const row of data) { for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length); }
        const p = (s: string, w: number) => s.padEnd(w);
        process.stdout.write(`${headers.map((h, i) => p(h, widths[i])).join("  ")}\n`);
        process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
        for (const row of data) process.stdout.write(`${row.map((c, i) => p(c, widths[i])).join("  ")}\n`);
        process.exit(0);
      }

      // Dry run (non-force)
      if (opts.dryRun && !opts.force) {
        const deltas = discoverDeltas(harnesses as Harness[], auth.userSlug, projectFilter, allowedProjects.size > 0 ? allowedProjects : undefined);
        const totalLines = deltas.reduce((sum, d) => sum + d.lines.length, 0);
        if (totalLines === 0) { process.stderr.write("No new data to sync.\n"); process.exit(0); }
        process.stderr.write("\n--- DRY RUN ---\n\n");
        for (const d of deltas) process.stdout.write(`${d.mode} ${d.key} (${d.lines.length} lines, offset=${d.lineOffset})\n`);
        process.exit(0);
      }

      // Force: preview what would be replaced, warn about pruned files
      if (opts.force) {
        const code = await previewAndConfirmForce(harnesses as Harness[], auth, url, projectFilter, allowedProjects);
        process.exit(code);
      }

      // Sync (incremental)
      const result = await runSync(harnesses as Harness[], auth.userSlug, url, auth.apiKey, false, projectFilter, allowedProjects.size > 0 ? allowedProjects : undefined);
      process.exit(result.errors.length === 0 ? 0 : 1);
    });

  await program.parseAsync();
}

main();
