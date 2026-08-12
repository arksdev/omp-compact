# omp-compact

**English** · [Русский](README.ru.md)

![omp-compact](docs/assets/hero.jpg)

## Install from the Marketplace

You need **OMP installed — [https://omp.sh/](https://omp.sh/)**.

```bash
omp plugin marketplace add arksdev/omp-compact
omp plugin install omp-compact@arksdev
```

Restart OMP and open `/compact-settings`. If the menu opens, the plugin is loaded. You only need to add the Marketplace once; after that, you can update the plugin with the standard OMP commands.

## What the plugin does

During a large task, OMP shows many separate cards: which files it read, what it searched for, which commands it ran, and what it edited. After a few steps, that log becomes long and the important changes are hard to spot.

`omp-compact` makes the log shorter and easier to read:

- while a task is running, it shows each action as one short line and keeps the original order;
- when OMP finishes its answer, it can remove temporary reads, searches, and commands;
- it keeps verified file changes, created Git commits, and final statistics;
- if the task is interrupted or ends with an error and no final answer, it does not hide anything needed for diagnosis;
- it does not replace OMP tools or change permissions, command execution, or results.

Example while OMP is working:

```text
Working… read src/index.ts
• read src/index.ts
• grep registerTool in src
• bash: bun test
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
```

After a successful answer, the default `live` mode keeps only useful history:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• git commit: 1983fsdf34, a4c12de890
[ 27 actions · 28.2k sent · 1.3k received · 95% cache (480.2k hit) · 1h 20m 32s ]
<assistant answer>
```

## Three modes

Choose a mode in `/compact-settings`. The selected mode is fixed for the current logical run, from the moment the agent starts working until its final answer.

| Mode | While OMP is working | After a successful answer | Best for |
| --- | --- | --- | --- |
| `compact` | All supported actions appear as short lines | The entire compact log remains | Keeping a complete action history without large native cards |
| `live` — default | The same complete compact log | File changes, Git summary, and statistics remain; temporary actions are removed | Everyday use: you can watch the process while keeping the transcript clean |
| `clear` | Ordinary tool lines are hidden | The answer and, if enabled, statistics remain | The quietest possible interface |

Unknown, interactive, expanded, or incompatible tools remain in OMP's native interface. In every mode, an abort or error without a final answer preserves the diagnostic log.

## Additional options

All settings are available through `/compact-settings`. Plugin-only values are stored in `~/.omp/agent/omp-compact/config.json`; profiles and `PI_CODING_AGENT_DIR` change this path according to OMP's normal rules.

### Short file names — `Compact paths`

When enabled, an absolute path inside the current project is shortened:

```text
/Volumes/work/project/src/index.ts:10-20
-> src/index.ts:10-20
```

This changes display only. The plugin does not rewrite tool arguments, files, or stored evidence. External paths, URIs, archive or SQLite selectors, and unsafe paths containing `..` remain unchanged.

JSON:

```json
{ "compactPaths": true }
```

### Git — `Retain Git rows`

The plugin recognizes Git activity from Bash commands that already ran and their results. It does not run hidden `git log`, `rev-parse`, or other probes.

- In `live`, Git actions are visible while OMP is working and are replaced after the answer by one line containing verified hashes for created commits.
- A failed commit or a commit without a hash is not included in the final line.
- If you disable this option, `live` shows neither intermediate Git rows nor the terminal Git summary.
- `compact` keeps the complete short Git log regardless of this option; `clear` hides it with the other ordinary rows.
- The newest commit in a series is highlighted with color.

JSON:

```json
{ "retainGitLive": true }
```

### Auto-shake

Auto-shake automatically calls OMP's native `AgentSession.shake("elide")` after an eligible successful logical run. It replaces heavy old tool results and large blocks with short placeholders containing an `artifact://` recovery link. This frees model context without removing the plugin's visual history.

Auto-shake is **disabled by default**. When enabled, its default threshold is **120,000 tokens**.

In `/compact-settings`:

1. Enable `Auto-shake`.
2. Set `Shake threshold` to a token count. After a logical run completes, the plugin performs one shake if the current context is above that limit. Set the limit to `0` to run it after every eligible logical run.

Example JSON with a 120,000-token threshold:

```json
{
  "autoShake": {
    "enabled": true,
    "thresholdTokens": 120000
  }
}
```

To shake after every eligible logical run:

```json
{
  "autoShake": {
    "enabled": true,
    "thresholdTokens": 0
  }
}
```

`OMP_COMPACT_SHAKE=1` enables auto-shake on top of the config; `OMP_COMPACT_SHAKE=0` disables it. The threshold still comes from JSON.

**How this differs from OMP's compact strategy:** auto-shake does not create an LLM summary and does not replace the current session with a compressed recap. It surgically removes heavy old content through `shake("elide")`. It runs only after a successful final answer; it is skipped for subagents, continuations, aborts or errors, and unknown token usage when the threshold is positive. If the context has already exceeded its limit, auto-shake has no separate compaction or model-switch fallback; recovery remains the responsibility of OMP's standard context-maintenance configuration.

### Thinking blocks and Recap summary

These two switches change **OMP's own configuration**, not only the plugin JSON:

- `Thinking blocks` controls whether reasoning/thinking blocks are visible. The plugin writes the inverse value to OMP's `hideThinkingBlock` setting. Restart OMP after changing it.
- `Recap summary` (called `Idle Recap` in OMP) controls OMP's `recap.enabled` setting. When enabled, OMP can generate a short summary of the current state after an idle period. This change takes effect without a restart.

The plugin first saves these values through OMP's live `session.settings` and only then updates their mirror in its own JSON. It does not call `Settings.init()` or alter other OMP settings. If a suitable main session is unavailable, the menu shows `n/a` and the host settings are not changed.

### Statistics

`Run statistics` adds one line after a completed run. You can independently enable actions, sent and received tokens, cache hits, and elapsed time. If any tool failed, the row uses the warning color.

## Safe removal

You can disable the plugin first without uninstalling it:

```bash
omp plugin disable omp-compact@arksdev
```

To remove a Marketplace installation completely:

```bash
omp plugin uninstall omp-compact@arksdev
```

If the plugin is installed in both user and project scope, remove the required copy explicitly:

```bash
omp plugin uninstall --scope user omp-compact@arksdev
omp plugin uninstall --scope project omp-compact@arksdev
```

Restart OMP after uninstalling. The plugin no longer installs its wrappers, and the interface returns completely to native OMP. You can optionally remove only the plugin's saved settings:

```bash
rm ~/.omp/agent/omp-compact/config.json
```

For a profile, the config is stored at `~/.omp/profiles/<name>/agent/omp-compact/config.json`. Removing this file does not change the stock OMP settings `recap.enabled` and `hideThinkingBlock`, because those values have already been saved in OMP's own config. Restore them through OMP's standard settings if needed. You can keep the Marketplace catalog for a future reinstall or remove it separately:

```bash
omp plugin marketplace remove arksdev
```

## Other installation methods

From a Git checkout:

```bash
git clone https://github.com/arksdev/omp-compact.git
cd omp-compact
bun install --frozen-lockfile
bun run omp
```

`bun run omp` loads only `./.omp-plugin/index.ts` through `--no-extensions`, preventing a second copy from loading when the plugin is already installed. For a permanent Marketplace or linked installation, use ordinary `omp` so the rest of your extensions remain enabled.

Direct launch for one run:

```bash
omp -e /absolute/path/to/omp-compact/.omp-plugin/index.ts
```

## Compatibility and documentation

The supported range is **OMP 17.2.12 and later**. The release gate is pinned to stock OMP 17.2.12; newer versions are treated as compatible unless they change the private TUI shape. If that happens, capability checks fail open to native rendering—please report the OMP version and reproduction in a GitHub issue.

- [Full documentation](docs/FULL-DOCUMENTATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

To verify a repository checkout:

```bash
bun install --frozen-lockfile
bun run check
```

## License

[MIT](LICENSE)
