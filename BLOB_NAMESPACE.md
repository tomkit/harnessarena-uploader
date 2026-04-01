# Blob Store Namespace Hierarchy

Sanitized harness logs are stored in Vercel Blob Store with a structured namespace path. Each level of the hierarchy represents a distinct concept.

## Layout

```
{org}/{user}/{harness}/{project}/{logType}/{sourceFile}
```

| Level | Field | Values | Description |
|-------|-------|--------|-------------|
| 1 | org | `_personal`, `{org-slug}` | Organization. `_personal` for users without an org. |
| 2 | user | `{username}` | User slug (e.g. `tomkit`). |
| 3 | harness | `claude`, `codex`, `gemini`, `cursor`, `opencode` | AI coding harness that produced the logs. |
| 4 | project | `{project-name}`, `_global` | Project slug. `_global` when the source format is not project-scoped. |
| 5 | logType | `session`, `subagent`, `meta`, `history` | Category of log data (see below). |
| 6 | sourceFile | `{name}.{ext}` | Canonicalized filename. Path separators are replaced with `--`. |

## Log Types

| logType | Description | Examples |
|---------|-------------|---------|
| `session` | Primary session event data | Claude JSONL sessions, Codex rollout JSONL, Gemini session JSON, Cursor/OpenCode SQLite exports |
| `subagent` | Subagent session data | Claude subagent JSONL files |
| `meta` | Metadata and indexes | Claude `sessions-index.json`, Codex `threads.jsonl` + `spawn_edges.jsonl` |
| `history` | Cross-session prompt history | Claude `history.jsonl` |

## Blob Suffixes

Blobs are append-only — nothing is ever overwritten or deleted (except via `--force`).

| Suffix | Meaning | Used for |
|--------|---------|----------|
| `.0001`, `.0002`, ... | Sequential append chunks | Append-only sources (Claude JSONL, Codex rollout, Claude history) |
| `.v0001`, `.v0002`, ... | Versioned snapshots | Rewritten sources (Gemini JSON, Cursor/OpenCode exports, Claude index) |
| `-latest` | Pointer to current version | Written alongside `.vNNNN` blobs; contains `{ version, url }` |

At read time:
- **Append sources**: merge all `.NNNN` blobs in order to reconstruct the full file.
- **Replace sources**: read the `-latest` pointer to find the current `.vNNNN` blob.

## Examples

```
Claude session:
  _personal/tomkit/claude/myproject/session/abc123.jsonl.0001

Claude subagent:
  _personal/tomkit/claude/myproject/subagent/abc123--agent-a1b2c3.jsonl.0001

Claude session index:
  _personal/tomkit/claude/myproject/meta/sessions-index.json.v0001

Claude prompt history:
  _personal/tomkit/claude/_global/history/history.jsonl.0001

Codex thread metadata:
  _personal/tomkit/codex/_global/meta/threads.jsonl.v0001
  _personal/tomkit/codex/_global/meta/spawn_edges.jsonl.v0001

Codex session rollout:
  _personal/tomkit/codex/_global/session/2026--03--31--rollout-xyz.jsonl.0001

Gemini session:
  _personal/tomkit/gemini/aa4607c0da50/session/session-2026-03-31-abc.json.v0001

Cursor session:
  _personal/tomkit/cursor/_global/session/e674aa28.jsonl.v0001

OpenCode session:
  _personal/tomkit/opencode/_global/session/opencode.jsonl.v0001
```

## Prefix Queries

The hierarchy supports efficient prefix queries at any level:

```
_personal/tomkit/                          — all data for a user
_personal/tomkit/claude/                   — all Claude data
_personal/tomkit/claude/myproject/         — one project's Claude data
_personal/tomkit/claude/myproject/session/ — just session files
```

## Watermarks

The uploader tracks sync progress per namespace in `~/.harnessarena/watermarks.json`:

- **Append sources**: stores the SHA-256 hash of the last uploaded line + line number. On next sync, finds that line and sends only new lines after it.
- **Replace sources**: stores the SHA-256 hash of the full content. On next sync, skips if unchanged.

If watermarks are lost (e.g. `--force`), the uploader re-uploads everything. The server assigns new sequence/version numbers without conflicts.
