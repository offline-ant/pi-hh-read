# pi-hh-read

Hashline-tagged read and verified edit tools for [pi](https://github.com/badlogic/pi-mono).

Based on the idea from [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
by Can Boluk: content-hashed line tags improve edit accuracy across models while
cutting token usage.

## How it works

When the model reads a file with `change_file: true`, every line is prefixed
with a 2-char base-62 content hash: `<hash>|<content>`. Empty lines show `  |`.
Duplicate hashes are displayed for all occurrences.

When editing via `change_file`, hashes resolve to the first match at or after
the `offset` line. If no offset is given and a hash matches multiple lines,
the first match is used and a warning is emitted. Stale or missing hashes are
rejected before any edit occurs.

## Extensions

### Hashline Read (`hh-read.ts`)

Overrides the built-in `read` tool. For text files, every line is prefixed with
`<hash>|` where hash is a 2-char base-62 digest (FNV-1a) of the line content.
Empty lines show `  |`. Images pass through unchanged.

Parameters:
- `path` — File to read (relative or absolute)
- `offset` — Line number to start from (1-indexed)
- `limit` — Maximum number of lines to read
- `change_file` — Set to `true` to enable hash tags (default: `false`)

### change_file (`edit-file.ts`)

Hash-addressed file editing. Lines are targeted by their 2-char hash from read
output.

| Mode | Parameters | Behavior |
|---|---|---|
| Create/overwrite | `path`, `content` | Creates or overwrites a file |
| Insert | `path`, `hash_start`, `content` | Inserts before the hashed line |
| Replace | `path`, `hash_start`, `hash_stop`, `content` | Replaces the hash range (inclusive) |
| Delete | `path`, `hash_start` (optional `hash_stop`) | Deletes the line or range |

**Duplicate hashes:** When a hash matches multiple lines (e.g. `}` or repeated
patterns), provide `offset` (1-indexed) to start the search from a specific
line. Without offset, the first match is used and a warning is emitted.

### Tweaks (`tweaks.ts`)

Session-level adjustments:
- Enables `grep` (registered but not in the default active set)
- Disables `edit` and `write` (prefer `change_file`)

### Hashline utilities (`hashline.ts`)

Shared module (not an extension). Provides:
- `lineHash(text)` — FNV-1a to 2-char base-62 (3844 values)
- `tagLines(lines)` — prefix lines with `<hash>|`, empty lines get `  |`
- `resolveHash(fileLines, hash, offset?)` — hash to line number, first match at or after offset

## Installation

Add to your pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "/path/to/pi-hh-read"
  ]
}
```
