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
- vibe-compact rows: on
- Advisor nit/concern notes: off; blockers stay full
- Statistics: on (all fields)
- Auto-shake: off; configured threshold: `120000` tokens
- Display-cycle shortcut: `alt+c`

**Open settings menu:** `/compact-settings` in any OMP session

**Cycle the display:** press `alt+c` in any OMP session

---

## Display-Cycle Shortcut

`alt+c` steps the display through four states, in this order:

```
compact → live → clear → off → compact
```

The mode changes only between the three enabled states; the plugin's master
switch flips only on the step into `off` and the step out of it. Turning the
plugin off keeps the last mode in the config file, so nothing is lost; turning
it back on always lands on `compact`, so the cycle order stays the same no
matter where you joined it.

Each press prints one line naming what will apply, for example
`Compact: live — takes effect next run` or `Compact: off — from the next run`.

Two things are worth knowing:

- **A press applies from the next logical run.** The runtime captures one
  settings snapshot per run, so pressing the key mid-run never changes the
  answer already being rendered.
- **Changing the chord requires restarting OMP.** The extension interface can
  register a shortcut but cannot unregister one, so a new chord binds only on
  the next start. The settings dialog says so when you save.

If `OMP_COMPACT_PLUGIN` or `OMP_COMPACT_MODE` pins a value, the press reports
the pinned value instead of claiming a change the environment forbids.

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
| `Enter` | On the cycle-shortcut row: start typing a new chord (`Enter` confirms, `Esc` cancels) |

### Complete Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **enabled** | `true` | Master switch for plugin runtime |
| **mode** | `"live"` | `compact`, `live`, or `clear` |
| **compactPaths** | `true` | Show project-relative paths |
| **retainGitLive** | `true` | Show Git operations and commit summary |
| **compactVibeRows** | `true` | Compact rows for the vibe tools (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`); `false` restores their stock cards in every mode, including `clear` |
| **compactAdvisorNotes** | `false` | Condense only advisor `nit` and `concern` notes into compact rows (long notes wrap as in the stock card); `blocker`, unknown-severity, unreadable-metadata and unproven cards keep the full native card. Turning tool-output expansion on always shows the full native card. Changes presentation only, never stored messages or model context |
| **displayCycleKey** | `"alt+c"` | Chord that cycles the display: compact → live → clear → off → compact. Must be free; a chord OMP already uses is rejected. Changing it needs an OMP restart |
| **autoShake.enabled** | `false` | Run stock `shake("elide")` after an eligible successful logical run |
| **autoShake.thresholdTokens** | `120000` | Minimum context usage for auto-shake; `0` means every eligible run |
| **stats.enabled** | `true` | Show one-line stats summary |
| **stats.actions** | `true` | Count of tool executions |
| **stats.sent** | `true` | Fresh (uncached) input tokens |
| **stats.received** | `true` | Output token usage |
| **stats.cache** | `true` | Cached tokens, their share, and cache writes |
| **stats.time** | `true` | Wall time duration |
| **stats.clock** | `true` | Local completion time as `hh:mm`, appended after the bracketed segments. Needs a row to ride on: with every other stats field off, nothing renders |
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
  "compactVibeRows": true,
  "compactAdvisorNotes": false,
  "displayCycleKey": "alt+c",
  "stats": {
    "enabled": true,
    "actions": true,
    "sent": true,
    "received": true,
    "cache": true,
    "time": true,
    "clock": true
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

- **Writers:** Same-process updates are serialized on an in-process queue and composed with leaf patches; there is no lock file. Separate OS processes writing the same JSON path remain last-writer-wins (atomic rename avoids torn reads, not lost updates).

---

## Environment Variables

| Variable | Values | Effect |
|----------|--------|--------|
| `OMP_COMPACT_PLUGIN` | `0` / `false` | Hard-disable runtime |
| `OMP_COMPACT_MODE` | `compact` / `live` / `clear` | Override mode |
| `OMP_COMPACT_MODE` | `off` | Legacy hard-disable |
| `OMP_COMPACT_SHAKE` | `1` / `0` | Override auto-shake |
| `OMP_COMPACT_CONFIG` | path | Override config file path |
| `OMP_COMPACT_TRACE` | `1` | Log every native fail-open to stderr |

**Precedence:** Env vars override config file. Menu saves don't write env vars to JSON.

`OMP_COMPACT_SHAKE` overrides only the enabled flag. The threshold still comes from JSON. Auto-shake uses `shake("elide")`; it does not produce a compaction summary or provide a fallback after a context limit has already been exceeded.

`OMP_COMPACT_TRACE=1` explains framed stock cards inside a compact session. A framed card always means the plugin could not prove which tool call owns that component, and nothing in the session transcript records that decision, so the trace names the branch instead: `order pairing declined: 1 unbound card(s) vs 2 started state(s) [read, bash]`, `rebuild pairing left 1 card(s) and 0 read group(s) native`, `native fail-open: ambiguous id ownership on a tool card (updateResult)`, and one `unbound card rendered native` per card. Unset by default; the message is never built while off.

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
