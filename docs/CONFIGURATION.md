# Configuration

Complete reference for all omp-compact settings, config file format, and environment variables.

---

## Quick Reference

**Default path:** `~/.omp/agent/omp-compact/config.json`

**Default settings:**
- Plugin enabled
- Mode: `live`
- Project-relative paths: on
- Git summary: on
- Statistics: on (all fields)
- Auto-shake: off; configured threshold: `120000` tokens

**Open settings menu:** `/compact-settings` in any OMP session

---

## Settings Menu

### Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate up/down |
| `k` / `j` | Navigate up/down (vim-style) |
| `←` / `→` | Cycle mode values |
| `Space` / `Enter` | Toggle boolean or start editing number |
| `s` | Save changes to config file |
| `Esc` / `c` | Close without saving |

### Complete Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **enabled** | `true` | Master switch for plugin runtime |
| **mode** | `"live"` | `compact`, `live`, or `clear` |
| **compactPaths** | `true` | Show project-relative paths |
| **retainGitLive** | `true` | Show Git operations and commit summary |
| **autoShake.enabled** | `false` | Run stock `shake("elide")` after an eligible successful logical run |
| **autoShake.thresholdTokens** | `120000` | Minimum context usage for auto-shake; `0` means every eligible run |
| **stats.enabled** | `true` | Show one-line stats summary |
| **stats.actions** | `true` | Count of tool executions |
| **stats.sent** | `true` | Input token usage |
| **stats.received** | `true` | Output token usage |
| **stats.cache** | `true` | Cache hit % and count |
| **stats.time** | `true` | Wall time duration |
| **host.recapEnabled** | `true` | Mirror and save OMP `recap.enabled`; takes effect immediately |
| **host.thinkingBlocksVisible** | `true` | Inverse of OMP `hideThinkingBlock`; restart OMP after changing |

---

## Config File Format

### JSON Schema (Version 1)

```json
{
  "version": 1,
  "enabled": true,
  "mode": "live",
  "retainGitLive": true,
  "compactPaths": true,
  "stats": {
    "enabled": true,
    "actions": true,
    "sent": true,
    "received": true,
    "cache": true,
    "time": true
  },
  "autoShake": {
    "enabled": false,
    "thresholdTokens": 120000
  },
  "host": {
    "recapEnabled": true,
    "thinkingBlocksVisible": true
  }
}
```

### Validation Limits

- **File size:** Max 65,536 bytes (64 KB)
- **Nesting depth:** Max 16 levels
- **thresholdTokens:** Integer 0–10,000,000
- **Invalid fields:** Fall back to defaults with one warning

---

## Environment Variables

| Variable | Values | Effect |
|----------|--------|--------|
| `OMP_COMPACT_PLUGIN` | `0` / `false` | Hard-disable runtime |
| `OMP_COMPACT_MODE` | `compact` / `live` / `clear` | Override mode |
| `OMP_COMPACT_MODE` | `off` | Legacy hard-disable |
| `OMP_COMPACT_SHAKE` | `1` / `0` | Override auto-shake |
| `OMP_COMPACT_CONFIG` | path | Override config file path |

**Precedence:** Env vars override config file. Menu saves don't write env vars to JSON.

`OMP_COMPACT_SHAKE` overrides only the enabled flag. The threshold still comes from JSON. Auto-shake uses `shake("elide")`; it does not produce a compaction summary or provide a fallback after a context limit has already been exceeded.

The two `host.*` values are mirrors of stock OMP settings. Saving them through `/compact-settings` writes OMP's live `session.settings` first, then updates plugin JSON. `omp-compact` does not manage Browser Relay or Collab Relay settings.

---

## Examples

### Minimal Config
```json
{
  "version": 1
}
```

### Compact Mode, No Git
```json
{
  "version": 1,
  "mode": "compact",
  "retainGitLive": false
}
```

### Clear Mode with Stats Only
```json
{
  "version": 1,
  "mode": "clear",
  "stats": {
    "enabled": true
  }
}
```

---

## See Also

- [Full Documentation](FULL-DOCUMENTATION.md) — Complete user guide
- [Architecture](ARCHITECTURE.md) — Config store implementation
