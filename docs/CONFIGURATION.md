# Configuration

Complete reference for all omp-compact settings, config file format, and environment variables.

---

## Quick Reference

**Default path:** `~/.omp/agent/omp-compact/config.json`

**Required OMP setting:** `/settings → Tools → Extensions → Extension Transcript Presenters` must be on (OMP 18.17+ ships it off). The plugin never changes it.

**Default settings:**
- Plugin enabled
- Mode: `live`
- Project-relative paths: on
- Git summary: on
- vibe-compact rows: on
- Advisor nit/concern notes: off; blockers stay full
- Statistics: on (all fields)
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

Reading the current state and computing the next step happen inside the save
queue too. Overlapping presses each advance once, and a preceding menu save
is observed rather than overwritten by an older keypress snapshot.

Two things are worth knowing:

- **A press applies from the next logical run.** The runtime captures one
  settings snapshot per run, so pressing the key mid-run never changes the
  answer already being rendered.
- **Changing the chord requires restarting OMP.** The extension interface can
  register a shortcut but cannot unregister one, so a new chord binds only on
  the next start. The settings dialog says so when you close it.

If `OMP_COMPACT_PLUGIN` or `OMP_COMPACT_MODE` pins a value, the press reports
the pinned value instead of claiming a change the environment forbids.

---

## Settings Menu

### Controls

The menu is OMP's own settings list, in four sections: `General`, `Display`,
`Statistics` and `Tool cards`. A value that differs from its default is drawn
in OMP's changed color. Each change is saved to the config file at once, as in
OMP's `/settings`; when you close the menu, one notice confirms the save (and
names an env variable that keeps a saved value from taking effect).

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between settings |
| `PgUp` / `PgDn` | Jump to the previous/next section |
| Typing | Search the settings; `Backspace` edits the search |
| `Space` / `Enter` | Toggle a boolean or step to the next value, saved at once |
| `Esc` | Clear the search; with no search, close the menu |
| `Enter` | On the cycle-shortcut row: open a field for a new chord (`Enter` saves it, `Esc` goes back) |

The parts of the usage row (`Actions` to `Add local time`) are listed only while
`Run statistics` is on.

### Complete Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **enabled** | `true` | Master switch for plugin runtime |
| **mode** | `"live"` | `compact`, `live`, or `clear` |
| **compactPaths** | `true` | Show project-relative paths |
| **retainGitLive** | `true` | Show Git operations and commit summary |
| **compactVibeRows** | `true` | Compact rows for the vibe tools (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`); `false` restores their stock cards in every mode, including `clear` |
| **compactAdvisorNotes** | `false` | Condense only advisor `nit` and `concern` notes into compact rows; `blocker`, unknown-severity and unreadable-details cards keep OMP's full card. An expanded card always shows OMP's full card. Changes presentation only, never stored messages or model context |
| **displayCycleKey** | `"alt+c"` | Chord that cycles the display: compact → live → clear → off → compact. Must be free; a chord OMP already uses is rejected. Changing it needs an OMP restart |
| **tools** | `{}` | Per-tool display, keyed by tool name (an `xd://` device by its own name; `ast-grep` and `ast_grep` name the same tool): `rows` (one-line rows that follow the mode), `newest` (the newest call keeps OMP's card while the agent works), `open` (OMP's card in every mode and after the answer). A tool without an entry uses its default: `newest` for `wait` and `todo`, `rows` otherwise. `ask` and the vibe tools ignore entries. Invalid entries are skipped with a warning |
| **stats.enabled** | `true` | Show one-line stats summary |
| **stats.actions** | `true` | Count of tool executions |
| **stats.sent** | `true` | Fresh (uncached) input tokens |
| **stats.received** | `true` | Output token usage |
| **stats.cache** | `true` | Cached tokens, their share, and cache writes |
| **stats.time** | `true` | Wall time duration |
| **stats.clock** | `true` | Local completion time as `hh:mm`, appended after the bracketed segments. Needs a row to ride on: with every other stats field off, nothing renders |

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
  "tools": {},
  "stats": {
    "enabled": true,
    "actions": true,
    "sent": true,
    "received": true,
    "cache": true,
    "time": true,
    "clock": true
  }
}
```

### Validation Limits

- **File size:** Max 65,536 bytes (64 KB)
- **Native reads:** Nonblocking open and descriptor stat reject non-regular files and oversized files before reading content. Accepted files read at most their stat size plus one byte; growth/shrink is rejected. Startup/load fall back to defaults; save refuses to replace an unreadable or invalid existing file.
- **Snapshot publication:** A delayed load cannot replace a newer reload or committed save. Subsequent updates always compose against the authoritative snapshot.
- **Nesting depth:** Max 16 levels
- **Invalid fields:** Fall back to defaults with one warning

- **Writers:** Same-process updates are serialized on an in-process queue and composed with leaf patches; there is no lock file. Separate OS processes writing the same JSON path remain last-writer-wins (atomic rename avoids torn reads, not lost updates).

---

## Environment Variables

| Variable | Values | Effect |
|----------|--------|--------|
| `OMP_COMPACT_PLUGIN` | `0` / `false` | Hard-disable runtime |
| `OMP_COMPACT_MODE` | `compact` / `live` / `clear` | Override mode |
| `OMP_COMPACT_MODE` | `off` | Legacy hard-disable |
| `OMP_COMPACT_CONFIG` | path | Override config file path; must resolve under your home or the project cwd, or it is ignored with a warning |

**Precedence:** Env vars override config file. The menu shows and saves the values in the file: it writes only the setting you change, never a value just because an env var forces it, and a value you pick is saved even when an env var forces the same one.

Files written by 1.x may still hold `autoShake` and `host` groups. They load fine: the plugin no longer reads them and carries them through saves as unknown keys.

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
