# HarnessArena Uploader

Upload your AI coding harness usage stats to [HarnessArena](https://harnessarena.com). **No conversation content is ever sent** — only anonymous metadata like token counts, model names, and session durations.

## Supported Harnesses

| Harness        | Binary   | Status |
| -------------- | -------- | ------ |
| Claude Code    | `claude` | ✅     |
| Codex (OpenAI) | `codex`  | ✅     |

## Quick Start

```bash
# Upload with the universal one-liner
curl -fsSL https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.sh | bash -s -- --api-key YOUR_API_KEY

# Download and run locally (no dependencies required)
curl -fsSL https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.py -o harnessarena_uploader.py

# Start the interactive wizard locally
python3 harnessarena_uploader.py

# Upload only specific harnesses
python3 harnessarena_uploader.py --harness claude --harness gemini

# List unique projects from selected harnesses
python3 harnessarena_uploader.py --harness claude --harness codex --list-projects

# Fold multiple project names under one alias before listing/uploading
python3 harnessarena_uploader.py --alias speeding-ticket-fighter=ticketfight-ai --list-projects

# Only sessions after a specific date
python3 harnessarena_uploader.py --since 2026-03-01
```

By default, the script starts an interactive wizard when run in a real terminal with no selection flags. The wizard:

- detects likely-installed harnesses
- lets you choose which harnesses to scan
- shows the project table and lets you choose projects
- optionally lets you fold projects together with aliases
- confirms before upload

Use `--no-wizard` to force flag-driven mode.

## What Gets Uploaded (Safe Metadata Only)

- ✅ Session ID (hashed, non-reversible)
- ✅ Harness name and version
- ✅ Project name (basename only, e.g. "my-app" not "/Users/you/Projects/my-app")
- ✅ Git repo name and branch
- ✅ Model used and provider
- ✅ Token counts (input, output, cached, total)
- ✅ Message counts (user vs assistant)
- ✅ Tool call names and counts
- ✅ Session duration
- ✅ Cost (if available)

## What is NEVER Uploaded (Private)

- ❌ Message content (your prompts and responses)
- ❌ Code snippets or file contents
- ❌ Full file paths
- ❌ API keys or credentials
- ❌ Tool call arguments or results

## Project Selection

Use `--harness` to select which harness histories to scan. Repeat it to include multiple harnesses:

```bash
python3 harnessarena_uploader.py --harness claude --harness codex --dry-run
```

Use `--list-projects` to print the unique project names seen in the selected harnesses and exit. Output is shown as an aligned terminal table with these columns:

```text
PROJECT  HARNESSES  SESSIONS  COMPLETENESS
```

Completeness values:

- `full`: project has at least one full session history record
- `partial`: project was recovered only from lightweight metadata/index records
- `prompts_only`: project was recovered only from prompt-history supplements
- `full+partial`, `full+prompts_only`, `partial+prompts_only`, `full+partial+prompts_only`: mixed evidence across retained history sources

Example:

```bash
python3 harnessarena_uploader.py --harness claude --harness codex --list-projects
```

Use `--alias OLD=NEW` to fold multiple project names under one canonical project name before listing or uploading:

```bash
python3 harnessarena_uploader.py \
  --harness claude \
  --harness codex \
  --alias speeding-ticket-fighter=ticketfight-ai \
  --alias ticketfight-web=ticketfight-ai \
  --list-projects
```

For a zero-install project listing flow, the same flags work through the universal one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.sh \
  | bash -s -- --harness claude --harness codex --list-projects
```

## History Locations

The uploader reads each harness's local history files from standard locations by default.

### Codex

Codex history defaults to:

```text
~/.codex/config.toml
~/.codex/state_5.sqlite
~/.codex/sessions/
```

You can override where the uploader reads Codex history from with environment variables.

Override precedence:

1. `HARNESSARENA_CODEX_CONFIG_PATH`
2. `HARNESSARENA_CODEX_STATE_DB_PATH`
3. `HARNESSARENA_CODEX_SESSIONS_DIR`
4. `HARNESSARENA_CODEX_HOME`
5. `CODEX_HOME`
6. default `~/.codex`

Variable defaults when unset:

```text
HARNESSARENA_CODEX_CONFIG_PATH  -> ${HARNESSARENA_CODEX_HOME:-${CODEX_HOME:-~/.codex}}/config.toml
HARNESSARENA_CODEX_STATE_DB_PATH -> ${HARNESSARENA_CODEX_HOME:-${CODEX_HOME:-~/.codex}}/state_5.sqlite
HARNESSARENA_CODEX_SESSIONS_DIR -> ${HARNESSARENA_CODEX_HOME:-${CODEX_HOME:-~/.codex}}/sessions
HARNESSARENA_CODEX_HOME        -> ${CODEX_HOME:-~/.codex}
CODEX_HOME                     -> ~/.codex
```

Examples:

```bash
# Point the uploader at an alternate Codex home
export HARNESSARENA_CODEX_HOME=/Volumes/data/custom-codex
python3 harnessarena_uploader.py --harness codex --dry-run
```

```bash
# Override individual Codex paths
export HARNESSARENA_CODEX_CONFIG_PATH=~/tmp/codex/config.toml
export HARNESSARENA_CODEX_STATE_DB_PATH=~/tmp/codex/state_5.sqlite
export HARNESSARENA_CODEX_SESSIONS_DIR=~/tmp/codex/sessions
python3 harnessarena_uploader.py --harness codex --dry-run
```

### Claude Code

Claude Code history defaults to:

```text
~/.claude/projects/
~/.claude/history.jsonl
~/.claude/session-env/
~/Library/Application Support/Claude/claude-code-sessions/
```

You can override where the uploader reads Claude Code history from with environment variables.

Override precedence:

1. `HARNESSARENA_CLAUDE_PROJECTS_DIR`
2. `HARNESSARENA_CLAUDE_HISTORY_PATH`
3. `HARNESSARENA_CLAUDE_SESSION_ENV_DIR`
4. `HARNESSARENA_CLAUDE_APP_SESSIONS_DIR`
5. `HARNESSARENA_CLAUDE_HOME`
6. default `~/.claude`

Variable defaults when unset:

```text
HARNESSARENA_CLAUDE_PROJECTS_DIR   -> ${HARNESSARENA_CLAUDE_HOME:-~/.claude}/projects
HARNESSARENA_CLAUDE_HISTORY_PATH   -> ${HARNESSARENA_CLAUDE_HOME:-~/.claude}/history.jsonl
HARNESSARENA_CLAUDE_SESSION_ENV_DIR -> ${HARNESSARENA_CLAUDE_HOME:-~/.claude}/session-env
HARNESSARENA_CLAUDE_APP_SESSIONS_DIR -> ~/Library/Application Support/Claude/claude-code-sessions
HARNESSARENA_CLAUDE_HOME           -> ~/.claude
```

Examples:

```bash
# Point the uploader at an alternate Claude home
export HARNESSARENA_CLAUDE_HOME=/Volumes/data/custom-claude
python3 harnessarena_uploader.py --harness claude --dry-run
```

```bash
# Override individual Claude paths
export HARNESSARENA_CLAUDE_PROJECTS_DIR=~/tmp/claude/projects
export HARNESSARENA_CLAUDE_HISTORY_PATH=~/tmp/claude/history.jsonl
export HARNESSARENA_CLAUDE_SESSION_ENV_DIR=~/tmp/claude/session-env
export HARNESSARENA_CLAUDE_APP_SESSIONS_DIR=~/tmp/claude/claude-code-sessions
python3 harnessarena_uploader.py --harness claude --dry-run
```

### Gemini CLI

Gemini history defaults to:

```text
~/.gemini/tmp/
~/.gemini/skills/
~/.agents/skills/
```

You can override where the uploader reads Gemini history and skill metadata from with environment variables.

Override precedence:

1. `HARNESSARENA_GEMINI_TMP_DIR`
2. `HARNESSARENA_GEMINI_SKILLS_DIR`
3. `HARNESSARENA_AGENTS_SKILLS_DIR`
4. `HARNESSARENA_GEMINI_HOME`
5. default `~/.gemini`

Variable defaults when unset:

```text
HARNESSARENA_GEMINI_TMP_DIR      -> ${HARNESSARENA_GEMINI_HOME:-~/.gemini}/tmp
HARNESSARENA_GEMINI_SKILLS_DIR   -> ${HARNESSARENA_GEMINI_HOME:-~/.gemini}/skills
HARNESSARENA_AGENTS_SKILLS_DIR   -> ~/.agents/skills
HARNESSARENA_GEMINI_HOME         -> ~/.gemini
```

Examples:

```bash
# Point the uploader at an alternate Gemini home
export HARNESSARENA_GEMINI_HOME=/Volumes/data/custom-gemini
python3 harnessarena_uploader.py --harness gemini --dry-run
```

```bash
# Override individual Gemini paths
export HARNESSARENA_GEMINI_TMP_DIR=~/tmp/gemini/tmp
export HARNESSARENA_GEMINI_SKILLS_DIR=~/tmp/gemini/skills
export HARNESSARENA_AGENTS_SKILLS_DIR=~/tmp/agents/skills
python3 harnessarena_uploader.py --harness gemini --dry-run
```

### Cursor Agent

Cursor Agent history defaults to:

```text
~/.cursor/chats/
```

You can override where the uploader reads Cursor Agent history from with environment variables.

Override precedence:

1. `HARNESSARENA_CURSOR_CHATS_DIR`
2. `HARNESSARENA_CURSOR_HOME`
3. default `~/.cursor`

Variable defaults when unset:

```text
HARNESSARENA_CURSOR_CHATS_DIR    -> ${HARNESSARENA_CURSOR_HOME:-~/.cursor}/chats
HARNESSARENA_CURSOR_HOME         -> ~/.cursor
```

Examples:

```bash
# Point the uploader at an alternate Cursor home
export HARNESSARENA_CURSOR_HOME=/Volumes/data/custom-cursor
python3 harnessarena_uploader.py --harness agent --dry-run
```

```bash
# Override the Cursor chats directory directly
export HARNESSARENA_CURSOR_CHATS_DIR=~/tmp/cursor/chats
python3 harnessarena_uploader.py --harness agent --dry-run
```

### OpenCode

OpenCode history defaults to:

```text
~/.local/share/opencode/opencode.db
~/.config/opencode/package.json
```

You can override where the uploader reads OpenCode history and install metadata from with environment variables.

Override precedence:

1. `HARNESSARENA_OPENCODE_DB_PATH`
2. `HARNESSARENA_OPENCODE_PACKAGE_JSON_PATH`
3. `HARNESSARENA_OPENCODE_CONFIG_DIR`
4. `HARNESSARENA_OPENCODE_HOME`
5. default `~/.local/share/opencode`

Variable defaults when unset:

```text
HARNESSARENA_OPENCODE_DB_PATH            -> ${HARNESSARENA_OPENCODE_HOME:-~/.local/share/opencode}/opencode.db
HARNESSARENA_OPENCODE_PACKAGE_JSON_PATH  -> ${HARNESSARENA_OPENCODE_CONFIG_DIR:-~/.config/opencode}/package.json
HARNESSARENA_OPENCODE_CONFIG_DIR         -> ~/.config/opencode
HARNESSARENA_OPENCODE_HOME               -> ~/.local/share/opencode
```

Examples:

```bash
# Point the uploader at an alternate OpenCode data directory
export HARNESSARENA_OPENCODE_HOME=/Volumes/data/custom-opencode
python3 harnessarena_uploader.py --harness opencode --dry-run
```

```bash
# Override individual OpenCode paths
export HARNESSARENA_OPENCODE_DB_PATH=~/tmp/opencode/opencode.db
export HARNESSARENA_OPENCODE_CONFIG_DIR=~/tmp/opencode-config
export HARNESSARENA_OPENCODE_PACKAGE_JSON_PATH=~/tmp/opencode-config/package.json
python3 harnessarena_uploader.py --harness opencode --dry-run
```

## Auditing

This is a single Python file with zero dependencies. Read it before running:

```bash
# View the source (~1000 lines)
less harnessarena_uploader.py

# Or check the hash
sha256sum harnessarena_uploader.py
```

If you use the universal one-liner, the shell bootstrap is also tiny and auditable:

```bash
curl -fsSL https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.sh
```

## CLI Reference

```
usage: harnessarena_uploader.py [-h] [--harness {claude,gemini,codex,agent,opencode,all}]
                                 [--since YYYY-MM-DD] [--dry-run] [--api-key API_KEY]
                                 [--api-url API_URL] [--alias OLD=NEW] [--list-projects]
                                 [--no-wizard] [--version]

Options:
  --harness NAME    Only scan specific harnesses (can repeat)
  --since DATE      Only include sessions after YYYY-MM-DD
  --dry-run         Show what would be uploaded without sending
  --api-key KEY     API key for harnessarena.com
  --api-url URL     API base URL (default: https://harnessarena.com)
  --alias OLD=NEW   Fold one project name into another before listing/upload
  --list-projects   List unique projects found in the selected harnesses and exit
  --no-wizard       Disable the interactive wizard and use flag-driven mode
  --version         Show version and exit
```

## License

MIT
