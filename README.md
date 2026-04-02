# Harness Arena Uploader

Sync your Claude Code and Codex session metadata to [Harness Arena](https://harnessarena.com) where you can analyze yourt vibes.

Only aggregated metrics are uploaded by default; raw session content requires full-data mode. All uploaded data can be exported or permanently deleted at any time.

## Supported Harnesses

| Harness        | Binary   | Status    |
| -------------- | -------- | --------- |
| Claude Code    | `claude` | Supported |
| Codex (OpenAI) | `codex`  | Supported |

## Quick Start

```bash
npx harnessarena-uploader
```

On first run, the CLI will open your browser to sign in via GitHub. After authentication, it enters the interactive wizard to select harnesses and projects, then syncs.

Subsequent runs sync incrementally — only new data since last sync.

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

| File                | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `config.json`       | Production credentials and sync scope               |
| `config.local.json` | Development credentials (when using `--dev`)        |
| `watermarks.json`   | Per-file sync progress (shared across environments) |

The sync scope (which harnesses and projects to sync) is saved after confirming a sync in the interactive wizard. Subsequent headless runs use the saved scope.

## History Locations

The uploader reads harness history from standard locations:

| Harness     | Default paths                                    |
| ----------- | ------------------------------------------------ |
| Claude Code | `~/.claude/projects/`, `~/.claude/history.jsonl` |
| Codex       | `~/.codex/state_5.sqlite`, `~/.codex/sessions/`  |

Override with environment variables (e.g., `HARNESSARENA_CLAUDE_HOME`, `HARNESSARENA_CODEX_HOME`).

Requires Node.js 22+.

## License

MIT
