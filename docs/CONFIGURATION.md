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
- Auto-shake: off

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
| **autoShake.enabled** | `false` | Trigger automatic context cleanup |
| **autoShake.thresholdTokens** | `2000000` | Min context usage for auto-shake |
| **stats.enabled** | `true` | Show one-line stats summary |
| **stats.actions** | `true` | Count of tool executions |
| **stats.sent** | `true` | Input token usage |
| **stats.received** | `true` | Output token usage |
| **stats.cache** | `true` | Cache hit % and count |
| **stats.time** | `true` | Wall time duration |
| **host.recapEnabled** | `true` | Mirror of OMP's recap setting |
| **host.thinkingBlocksVisible** | `true` | Inverse of OMP's hideThinkingBlock |

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
    "thresholdTokens": 2000000
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
