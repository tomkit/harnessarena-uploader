# Harness Arena Uploader

Sync AI coding harness session metadata to [Harness Arena](https://harnessarena.com). Only aggregated metrics are uploaded by default; raw session content requires full-data mode. All uploaded data can be exported or permanently deleted at any time.

## Supported Harnesses

| Harness        | Binary   | Status      |
| -------------- | -------- | ----------- |
| Claude Code    | `claude` | Supported   |
| Codex (OpenAI) | `codex`  | Supported   |
| Gemini CLI     | `gemini` | Coming soon |
| Cursor Agent   | `agent`  | Coming soon |
| OpenCode       | `opencode` | Coming soon |

## Quick Start

```bash
# Clone and run
git clone https://github.com/harnessarena/uploader.git
cd uploader
./harnessarena_uploader.sh
```

On first run, the CLI will open your browser to sign in via GitHub. After authentication, it enters the interactive wizard to select harnesses and projects, then syncs.

Subsequent runs sync incrementally (only new data since last sync).

## Authentication

The CLI uses a device authorization flow (RFC 8628):

1. Run `login` — the CLI generates a short code and opens your browser
2. Sign in with GitHub and enter the code to approve
3. An API key is saved locally in `~/.harnessarena/config.json`

```bash
./harnessarena_uploader.sh login         # production
./harnessarena_uploader.sh login --dev   # local dev server
./harnessarena_uploader.sh logout        # remove saved API key
```

Production and development use separate config files (`config.json` and `config.local.json`). Watermarks are shared.

## Commands

### sync (default)

Sync session metadata. This is the default command when no subcommand is specified.

```bash
# Incremental sync (only new data)
./harnessarena_uploader.sh

# Interactive wizard (select harnesses + projects)
./harnessarena_uploader.sh sync -i

# Dry run — show what would sync
./harnessarena_uploader.sh sync -n

# List discovered projects
./harnessarena_uploader.sh sync -l

# Sync specific harnesses only
./harnessarena_uploader.sh sync -H claude

# Sync specific projects only
./harnessarena_uploader.sh sync -p harnessarena-uploader -p vibing-history

# Force re-sync (replaces server data)
./harnessarena_uploader.sh sync -f
```

Force sync shows a preview comparing client vs server line counts before proceeding. If the server has more data than the client (e.g., because the harness pruned local logs), a warning is displayed.

### login / logout

```bash
./harnessarena_uploader.sh login         # sign in via GitHub
./harnessarena_uploader.sh logout        # remove API key
```

## CLI Reference

```
Usage: harnessarena-uploader [options] [command]

Commands:
  login [options]   Sign in via browser (GitHub OAuth)
  logout [options]  Remove saved API key and sign out
  sync [options]    Sync session metadata to Harness Arena

Sync options:
  -H, --harness <name>   Harnesses to scan (repeatable)
  -p, --projects <name>  Projects to sync (repeatable)
  -d, --dev              Use local dev server (localhost:3000)
  -n, --dry-run          Show what would sync without uploading
  -l, --list-projects    List discovered projects and exit
  -i, --interactive      Run the interactive wizard
  -f, --force            Force re-sync: stage then atomically swap
  -v, --version          Show version
  -h, --help             Show help
```

## What Gets Uploaded

By default, only sanitized metadata is uploaded:

- Session timestamps and durations
- Harness name and version
- Project name (folder basename only)
- Model and provider
- Token counts (input, output, cached)
- Tool call names and invocation counts
- Subagent types and counts
- MCP server names and call counts
- Skill names and usage

Raw session content (prompts, responses, code, file paths, tool arguments) is **never** uploaded unless full-data mode is explicitly enabled.

## Configuration

Config is stored in `~/.harnessarena/`:

| File | Purpose |
|------|---------|
| `config.json` | Production credentials and sync scope |
| `config.local.json` | Development credentials (when using `--dev`) |
| `watermarks.json` | Per-file sync progress (shared across environments) |

The sync scope (which harnesses and projects to sync) is saved after confirming a sync in the interactive wizard. Subsequent headless runs use the saved scope.

## History Locations

The uploader reads harness history from standard locations:

| Harness | Default paths |
|---------|---------------|
| Claude Code | `~/.claude/projects/`, `~/.claude/history.jsonl` |
| Codex | `~/.codex/state_5.sqlite`, `~/.codex/sessions/` |

Override with environment variables (e.g., `HARNESSARENA_CLAUDE_HOME`, `HARNESSARENA_CODEX_HOME`).

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run dev -- sync -d -n  # run in dev mode
```

Requires Node.js 22+.

## License

MIT
