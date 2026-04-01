import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandPath(value: string): string {
  if (value.startsWith("~")) {
    return join(homedir(), value.slice(1));
  }
  return resolve(value);
}

function env(key: string): string | undefined {
  return process.env[key];
}

export interface CodexHistoryPaths {
  home: string;
  configPath: string;
  stateDbPath: string;
  sessionsDir: string;
}

export interface ClaudeHistoryPaths {
  home: string;
  projectsDir: string;
  historyPath: string;
  sessionEnvDir: string;
  appSessionsDir: string;
}

export interface GeminiHistoryPaths {
  home: string;
  tmpDir: string;
  skillsDir: string;
  agentsSkillsDir: string;
}

export interface CursorHistoryPaths {
  home: string;
  chatsDir: string;
}

export interface OpenCodeHistoryPaths {
  home: string;
  dbPath: string;
  configDir: string;
  packageJsonPath: string;
}

export function getCodexHistoryPaths(): CodexHistoryPaths {
  const home = expandPath(env("HARNESSARENA_CODEX_HOME") ?? env("CODEX_HOME") ?? "~/.codex");
  return {
    home,
    configPath: expandPath(env("HARNESSARENA_CODEX_CONFIG_PATH") ?? join(home, "config.toml")),
    stateDbPath: expandPath(env("HARNESSARENA_CODEX_STATE_DB_PATH") ?? join(home, "state_5.sqlite")),
    sessionsDir: expandPath(env("HARNESSARENA_CODEX_SESSIONS_DIR") ?? join(home, "sessions")),
  };
}

export function getClaudeHistoryPaths(): ClaudeHistoryPaths {
  const home = expandPath(env("HARNESSARENA_CLAUDE_HOME") ?? "~/.claude");
  return {
    home,
    projectsDir: expandPath(env("HARNESSARENA_CLAUDE_PROJECTS_DIR") ?? join(home, "projects")),
    historyPath: expandPath(env("HARNESSARENA_CLAUDE_HISTORY_PATH") ?? join(home, "history.jsonl")),
    sessionEnvDir: expandPath(env("HARNESSARENA_CLAUDE_SESSION_ENV_DIR") ?? join(home, "session-env")),
    appSessionsDir: expandPath(
      env("HARNESSARENA_CLAUDE_APP_SESSIONS_DIR") ??
        join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
    ),
  };
}

export function getGeminiHistoryPaths(): GeminiHistoryPaths {
  const home = expandPath(env("HARNESSARENA_GEMINI_HOME") ?? "~/.gemini");
  return {
    home,
    tmpDir: expandPath(env("HARNESSARENA_GEMINI_TMP_DIR") ?? join(home, "tmp")),
    skillsDir: expandPath(env("HARNESSARENA_GEMINI_SKILLS_DIR") ?? join(home, "skills")),
    agentsSkillsDir: expandPath(
      env("HARNESSARENA_AGENTS_SKILLS_DIR") ?? join(homedir(), ".agents", "skills"),
    ),
  };
}

export function getCursorHistoryPaths(): CursorHistoryPaths {
  const home = expandPath(env("HARNESSARENA_CURSOR_HOME") ?? "~/.cursor");
  return {
    home,
    chatsDir: expandPath(env("HARNESSARENA_CURSOR_CHATS_DIR") ?? join(home, "chats")),
  };
}

export function getOpenCodeHistoryPaths(): OpenCodeHistoryPaths {
  const home = expandPath(
    env("HARNESSARENA_OPENCODE_HOME") ?? join(homedir(), ".local", "share", "opencode"),
  );
  const configDir = expandPath(
    env("HARNESSARENA_OPENCODE_CONFIG_DIR") ?? join(homedir(), ".config", "opencode"),
  );
  return {
    home,
    dbPath: expandPath(env("HARNESSARENA_OPENCODE_DB_PATH") ?? join(home, "opencode.db")),
    configDir,
    packageJsonPath: expandPath(
      env("HARNESSARENA_OPENCODE_PACKAGE_JSON_PATH") ?? join(configDir, "package.json"),
    ),
  };
}
