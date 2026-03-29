# HarnessArena Uploader

Upload your AI coding harness usage stats to [HarnessArena](https://harnessarena.com). **No conversation content is ever sent** — only anonymous metadata like token counts, model names, and session durations.

## Supported Harnesses

| Harness | Binary | Status |
|---------|--------|--------|
| Claude Code | `claude` | ✅ |
| Gemini CLI | `gemini` | ✅ |
| Codex (OpenAI) | `codex` | ✅ |
| Cursor Agent | `agent` | ✅ |
| OpenCode | `opencode` | ✅ |

## Quick Start

```bash
# Download and run (no dependencies required)
curl -fsSL https://raw.githubusercontent.com/tomkit/harnessarena-uploader/main/harnessarena_uploader.py -o harnessarena_uploader.py

# Preview what will be uploaded (nothing sent)
python3 harnessarena_uploader.py --dry-run

# Upload stats for a specific project
python3 harnessarena_uploader.py --project ~/Projects/my-app

# Upload only specific harnesses
python3 harnessarena_uploader.py --harness claude --harness gemini

# Only sessions from the last 7 days
python3 harnessarena_uploader.py --since 7d
```

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

## Auditing

This is a single Python file with zero dependencies. Read it before running:

```bash
# View the source (~1000 lines)
less harnessarena_uploader.py

# Or check the hash
sha256sum harnessarena_uploader.py
```

## CLI Reference

```
usage: harnessarena_uploader.py [-h] [--dry-run] [--project PATH]
                                 [--harness NAME] [--since DURATION]
                                 [--endpoint URL] [--version]

Options:
  --dry-run         Show what would be uploaded without sending
  --project PATH    Only scan sessions for this project directory
  --harness NAME    Only scan specific harness (can repeat)
  --since DURATION  Only include sessions newer than (e.g. 7d, 24h, 30m)
  --endpoint URL    Upload endpoint (default: https://harnessarena.com/api/upload)
  --version         Show version and exit
```

## License

MIT
