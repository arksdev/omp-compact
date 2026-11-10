# Architecture

How omp-compact decides what each transcript block shows, where its evidence comes from, and what it keeps between runs.

## Overview

omp 18.17 lets an extension choose how each block of the main transcript is drawn: `pi.registerTranscriptPresenter(presenter)`. omp asks the presenter about a block whenever the block's data changes, whenever the extension calls `ctx.ui.refreshTranscript(ids)`, and whenever it rebuilds the transcript. It draws the answer itself, in the plain terminal and in Tern's native view. The contract is in omp's `docs/extensions.md`, section "Transcript presenter", and the types in `packages/tui/src/chat/extension-types.ts`.

The plugin is that presenter plus the state its answers need:

```text
omp events ──► index.ts ──► SessionLedger ◄── branch walk (resume, /tree, /branch, compaction)
                  │              │
                  │ audit        ▼
                  └────────► presenter.ts ──► answer per block: undefined | "full" | "compact" | "hidden" | { compact: { label, rows } }
                                 ▲
                         omp asks per block
```

omp only asks while its setting `extensionRenderers.transcriptPresenters` is on. It ships off, and the plugin never turns it on: the setting belongs to the user. When a tool call has run in an interactive TUI session and omp still has not asked the presenter anything, the plugin shows one warning per process naming `/settings → Tools → Extensions → Extension Transcript Presenters`.

Tools themselves are untouched. The plugin registers no tool, wraps no tool, and patches no omp class. Execution, approval, results and the model context stay omp's.

## Answers

The presenter returns one of omp's answers:

| Answer | Meaning |
| --- | --- |
| `undefined` | Ask the next presenter, else omp's default drawing. A disabled run, an unknown block type, and anything the plugin cannot read answer this. |
| `"full"` | omp's full card: `ask` and other interactive tools, the newest `wait` or `todo` of a working run, `vibe_*` with `compactVibeRows` off, a blocking advisor note. |
| `"compact"` | omp's own one-row summary. Every tool the registry does not know gets this, so a new tool is never hidden without a description. |
| `"hidden"` | Nothing. A call the run's retention drops, or every ordinary call in `clear`. |
| `{ compact: { label, rows } }` | The plugin's rows: the first replaces omp's summary text, the rest go below it. |

omp draws an expanded block (`Ctrl+O`, or the block's toggle in Tern) in full whatever the presenter answers. That replaced the per-tool expansion rules 1.x had: every block now opens to omp's card, including calls the plugin hid.

omp keeps no earlier answer and may ask again at any time, so each answer is a function of the block and the ledger record it resolves to, nothing else. The presenter does no I/O beyond the one branch walk below, and keeps no caches that could go stale against the ledger.

### Row text

`render.ts` builds rows as ANSI strings, as it always has. `native-text.ts` turns one row into omp's `TspText` (a string or theme-token spans), which omp needs to draw the same row in Tern. omp draws the row's glyph itself, so the plugin drops its own leading `•` from the label.

### The Tern title probe

In Tern a compact tool node keeps omp's stock title and shows the label next to it, so a label that starts with the same word reads twice (`Read  read src.txt`). omp passes the presenter no signal for which view it is drawing. The plugin therefore copies the probe omp itself uses to pick Tern's native view: `TERM_PROGRAM` is `tern` (case-insensitive) and `PI_TUI_NATIVE` is not `0` (`ternNativeView` in `presenter.ts`). In that view it drops its leading title from the label when it is the same word as the card's stock title, and keeps it when they differ (`github: pr_create` on a `write` card). A routine row goes further: omp's head already shows the target, its meta and any error, so a lone row with no mutation or Git evidence, no summary and the card's own title answers plain `"compact"`. Evidence rows (`write: a.ts +1|0`, `git commit: ...`), vibe rows and leaf cards keep their label. Inside tmux `TERM_PROGRAM` names tmux, so the plugin draws terminal labels there, which is what omp does too. A wrong guess only changes whether a word repeats.

## SessionLedger (session-ledger.ts)

The block carries its own arguments and result, so the ledger holds only what the block lacks:

- **Runs.** A logical run starts at `agent_start` and spans tool-use continuations (`agent_end` with `willContinue`, or a `toolUse` stop). It ends at a terminal `agent_end`. The run freezes its settings snapshot (`mode`, `enabled`, `retainGitLive`, `compactVibeRows`) and display paths when it opens.
- **Phase.** `working` while the run is open. At its end `turn-ledger.ts` classifies the stop: a visible answer is `filtered`, an abort, error, blank answer or stop alongside a tool call is `full`. `compact` mode always ends `full`.
- **Calls.** `toolCallId` → one record per run: run, a hash of the final arguments, mutation evidence, Git evidence and the settle time. A block seen before its `tool_execution_start` (arguments still streaming) is recorded under the open run. A streaming block without an id yet draws as a call of the open run without a record. A call that arrives with no run open goes to a finished stray run and keeps its row.
- **Git projection.** Once a run ends, its commit hashes in call order and the call that carries the aggregate summary row (the last one with evidence) are computed once.
- **Reveal.** Whether a click on the run's stats row shows the calls the run hid.

The audit publishes evidence into the ledger only while the run is `working`. The terminal `agent_end` waits for the run's audit drain before it finalizes the run, so evidence that lands late still reaches its row, and evidence of a finished run is frozen.

### Branch walk

Past runs come from the session branch, walked once per branch: on the first block the ledger does not know, and again after `session_start`, a non-fork `session_switch`, `session_tree`, `session_branch` and `session_compact`. The walk reads:

- user messages as run boundaries, and an assistant message with a visible answer as the run's `filtered` end;
- assistant `toolCall` parts, and the `custom` `tool_execution_start` entries sessions from older omp versions recorded instead;
- the plugin's `omp-compact-write` and `omp-compact-git` entries, both as `custom` entries and as the `custom_message` carriers 1.x plugins wrote, including single-record Git entries without `records`;
- `omp-compact-stats` evidence, which ties a persisted stats row back to its run so its click still works after a resume. A row can land after the next run's answer, so it names one tool call of its run (`anchorToolCallId`); evidence without one, or whose call is unknown, belongs to the run the walk is in. With a repeated id the name resolves to the newest record at that point of the walk.

A restored run takes the settings selected now, not the ones it ran with: a resumed session reads the way the user has chosen to see runs today. Calls of the open run keep their live state through a walk.

Scoped write carriers sit after the entry that issued their write (`mutationBranchEntries` in `messages.ts`), so a carrier hydrates only a branch that contains that exact entry.

### Repeated ids

Some providers number tool calls per response (`call_0`), so a later run can reuse an earlier run's id, and omp gives the presenter no other identity. The ledger keeps one record per run under the id, newest last, each with `Bun.hash` of its final arguments, taken at `tool_execution_start` and in the branch walk. A lookup with one record returns it. With several, it hashes `block.args` and returns the newest match, else the newest record, which covers arguments still streaming. Omp strips the intent field `i` from the start event and adds it back to the block, so two hashes count as the same arguments when they differ only in one side lacking `i`; two different `i` values stay different, because a tool can own that argument. Live evidence goes to the newest record of a run still working. `refreshTranscript(ids)` asks both blocks again and each resolves its own record.

Remaining limit: calls with the same id and the same arguments in different runs cannot be told apart, and both blocks draw as the newest.

## Decision flow

### Tool calls (render-decision.ts)

`decideToolRender` is a pure ordered table from `(route, mode, phase, evidence)` to `native`, `host-compact`, `empty` or `tool-rows`. First match wins:

```text
1. no registry rule            → host-compact (omp's one-row summary, every mode and phase)
2. native-live (ask)           → native
3. compact rows switched off   → native (vibe tools with compactVibeRows=false)
4. clear + summary anchor + hashes → tool-rows, summary only (terminal phases)
5. clear                       → empty (every phase, abort and error included)
6. working + newest call of a live-card tool → native
7. filtered + kept-row        → tool-rows, the row stays without evidence
8. filtered + no mutations + no hashes → empty
9. working + live + no retainGitLive + Git evidence → empty
10. filtered                  → tool-rows, retention view (mutations stay; the anchor adds the commit summary)
11. otherwise                 → tool-rows, the full compact log with Git rows
```

The presenter maps `native` to `"full"`, `host-compact` to `"compact"`, and `empty` to `"hidden"` unless the run's reveal is on, in which case the call gets its compact rows back. Hashes count only once the run ended and only with `retainGitLive`; `clear` treats an interrupted end as terminal too, because the commits it made exist either way and the quiet view has no other place to show them.

`wait` and `todo` use the `live-card` route: their cards show current state, so only the newest call of each tool keeps its card. Older ones would show a frozen copy of the same state, and a run can make dozens of `wait` calls. A new call asks omp to redraw the one it replaces (`tool_execution_start` → `refreshTranscript`). A call whose arguments still stream without an id counts as the newest. In a plain terminal, if the replaced card already scrolled into native scrollback, that redraw costs omp one transcript replay (at most one per frame); in Tern it is a prop change. Their rows read `wait: <intent> · 2 jobs settled` and `todo: done Task two · 1/2`.

The user's per-tool choice (`tools` in the config, `tool-display.ts`) rewrites the route before this table runs, from the run's frozen settings snapshot: `open` becomes `native-live`, `newest` becomes `live-card` for the newest call of the tool while the run works, and `rows` (or an older `newest` call) takes the tool's row route. A `write` to `xd://<device>` is keyed by the device, which the ledger records on the call with its arguments. `ask` and the vibe tools ignore choices.

`task` uses `kept-row`: its live progress is in the `wait` card, and its row records what the run delegated: each task's name, else its agent, with unlabelled tasks counted (`task: Scout, reviewer +1`).

### Other blocks (leaf-views.ts)

omp also asks about blocks that are not tool calls. The plugin reads each from its structured data, never from rendered text, and answers `undefined` when it cannot, so omp draws its own card:

| Block | Compact view |
| --- | --- |
| event `ttsr_triggered` | the injected rule rows |
| event `todo_reminder` | one reminder row |
| message `skill-prompt` | a user's `/skill:` keeps omp's card while its run works (`compact` and `live`), then one skill row; one row throughout in `clear`, in history and for a skill the agent loaded. omp stamps the prompt before the run it opens starts, so `promptRun` ties it to the open run, or holds it pending until the next one starts; a prompt from before the session started is history |
| message `lsp-late-diagnostic` | one late-diagnostics row |
| message `bashExecution`, `pythonExecution` | one row for a user `!`/`$` run |
| message `advisor` | one row per `nit`/`concern` note, only with `compactAdvisorNotes`; a `blocker`, an unknown severity or unreadable details answer `"full"` |
| message `async-result`, `launch-completion` | omp's own card, or hidden, by `decideBackgroundCompletionRender` |

A background completion notice belongs to the run open when its block first appears. A notice with no run is restored history and follows the selected mode: shown in `compact`, hidden otherwise.

## Stats row (run-stats.ts)

`RunStats` sums `message_end` usage per unique assistant message and counts distinct tool calls across the whole logical run. At a terminal `agent_end` with a visible answer it freezes the evidence (`RunStatsEvidence`, version 1, keyed by run id). Aborts and errors drop it.

The row is a display custom message sent with `pi.sendMessage({ display: true }, { deliverAs: "nextTurn" })`, so it sits under the answer. That is omp's silent idle append: the entry is persisted with its `details` and only the new row is added to the chat. `{ triggerTurn: false }` alone rebuilds the transcript, which duplicates scrollback in tmux, wipes transient notices and resets expanded cards. The row waits in `IdleQueue` until `ctx.isIdle()`: a `nextTurn` message sent while omp still reports busy stays hidden until the next turn. If the next prompt starts first, the row waits for that run to end too and both rows go out in order.

The message renderer draws the row from `details` on every draw, so stats settings apply to old rows at once. The message `content` is a fixed marker, `[omp-compact turn stats]`, kept non-empty for providers in case the plugin is removed later. A `context` handler strips the message from the model's context. Advisors read session messages directly and bypass that handler, which is why the content carries no numbers.

In Tern's native view the row is clickable while its run hid calls: a click flips the run's reveal and refreshes the hidden ids, and a second click hides them again.

## Mutation audit

### Write verification (audit.ts)

```typescript
// Pre-image at tool_execution_start (sync read: must not lose the race).
export async function captureWriteCandidate(
    input: { toolCallId: string; args: unknown; cwd: string; root?: string },
    acceptTarget?: WriteTargetObserver,
): Promise<MutationCandidate | undefined>;

// Post-image and line diff after tool_execution_end.
export async function completeWriteCandidate(
    candidate: MutationCandidate | undefined,
    result: unknown,
    isError: boolean,
): Promise<MutationMessageDetails[]>;
```

omp invokes `tool_execution_start` listeners without awaiting them, so the pre-image read is synchronous: an async read could see the tool's own write and produce an empty diff. Completion needs a non-error result with an absolute `details.resolvedPath`, and the snapshot path, the resolved path and the completion-time canonical path must agree. Counts are exact line counts from a diff, never byte or mtime guesses. Missing candidates, path mismatches, unchanged bytes and over-budget diffs produce no entry.

An empty creation is exact `+0|0` with `created: true`; an empty overwrite is a no-op; a successful empty deletion is `delete -0`.

**Source ownership.** A write record captures the id of the entry that issued it and checks it again before publishing, through the read-only session manager. A replaced journal or an unverifiable source fails publication closed, so old evidence never lands in a new session.

**Target contention.** Capture claims the canonical target before reading. Two active claims on one target abandon both audits. Native writes are never serialized or changed; the guard sees this plugin's write events only.

**Path confinement (POSIX-only).** Pre-image reads and config-path acceptance share `isPathInsideRoot` (`path-inside-root.ts`). Pre- and post-image opens use `O_NOFOLLOW` on the confined destination; nested symlink hops are refused.

**Device dispatches.** A `write` to `xd://<device>` runs a mounted tool. `resolveToolAudit` gives it the audit kind `none`, so it never opens a write record. The device grammar is omp's own `parseXdUrl`.

### Edit verification (audit-diff.ts)

Edits count from omp's applied `diff` or `perFileResults`, only inside well-formed `@@` hunks, per file, so a partly failed multi-file edit keeps its successful files. `op: create` is an upsert: the plugin compares a synchronous bounded pre-image with omp's `newText` instead of trusting the all-add diff. Deletes without an exact pre-image count surface as count-less `exact: false` entries.

### Lifecycle (audit-lifecycle.ts)

`AuditLifecycle` registers each record synchronously at start, before the first await, so a fast end event finds it. `agent_end` snapshots the run's records at emission and drains them; work registered later belongs to the next drain. Records still unended at a terminal `agent_end` are abandoned; completions already in flight are awaited up to about five seconds.

## Git detection (git-records.ts)

The plugin reads Git activity from Bash commands that already ran and their results. It runs no hidden `git log`, `rev-parse` or other probes.

- **Commit banner.** Up to 8 lines within 8,192 bytes are scanned for `[branch (root-commit) hash] subject`. More than one banner-shaped line fails closed.
- **Quiet commits.** The hash comes from a `git log` right after the commit with identical global Git arguments, only `--oneline`, a positive count limit and optional `HEAD`. Its leading hash must carry the committed subject.
- **Shell text.** `&&` chains, one leading `cd <path> &&`, brace lists inside a word, and a double-quoted `$(printf …)`/`$(echo …)` with one literal argument are accepted. Chains joined by `;` or unescaped newlines stay ordinary Bash, because a successful last command proves nothing about the earlier ones.

In `live` the individual Git rows show while working and give way to one summary of verified hashes after the answer. `compact` keeps every row. `clear` shows only the summary, after an interrupted run as well. `retainGitLive=false` hides the rows and the summary in `live` and `clear`; the persisted evidence is unchanged. The summary sits under the run's last call with evidence that draws rows: a call shown as OMP's full card (`open`) cannot carry it and shows its own Git output.

## Configuration

### Bounded parsing (config.ts)

Config reads open with `O_NONBLOCK` and inspect the descriptor: non-regular files and files above 65,536 bytes are refused before any content read, and reads take at most the accepted size plus one byte. Nesting depth is capped at 16. Load fails open to defaults with one warning; save refuses to replace an unreadable or invalid file. Unknown keys, including the `autoShake` and `host` groups 1.x wrote, are carried through saves untouched. `OMP_COMPACT_CONFIG` must resolve under the user's home or the project cwd; otherwise it is ignored with one warning.

### Update queue (keyed-queue.ts)

Saves for one path run through an in-process queue and apply as leaf patches against a fresh read, so concurrent in-process edits to different fields both survive. There is no lock file: separate processes writing one file stay last-writer-wins, and the atomic rename only prevents torn reads.

### Display cycle (display-cycle.ts, cycle-handler.ts)

One chord (`alt+c` by default) walks `compact → live → clear → off → compact`. The keypress handler runs load, next-state and persist inside the same queue as dialog saves, so rapid presses each advance one step. Two omp constraints shape it:

1. `ExtensionAPI` can register a shortcut but not remove one, so the chord is read synchronously at load (`readDisplayCycleKeySync`) and a new chord needs a restart.
2. Conflicts come from omp's `pi.getShortcutConflict`; an occupied chord is refused rather than registered and silently dropped.

## Lifecycle

### Normal run

```text
agent_start           ledger.beginRun: freeze settings; RunStats.start
tool_execution_start  ledger.startCall; audit start (sync pre-image)
  omp asks            presenter: working rows
tool_execution_end    settle; audit end → evidence → refreshTranscript([id])
agent_end (toolUse)   run stays open; drain this response's audit
agent_start           same run continues
agent_end (answer)    drain; finalizeRun → phase filtered/full → refresh the run's ids
idle                  send the stats message
```

### Rebuild (resume, /tree, /branch, compaction)

```text
session_* event       invalidate restored history (the open run stays)
                      walk the new branch; refresh the restored ids
omp rebuilds          presenter answers from the walked ledger under the current settings
```

A `/fork` keeps the conversation and omp does not rebuild it, so the ledger stays as it is.

## Bounded inputs

- Config file: 65,536 bytes, depth 16
- Tool call id: 256 characters; tool name: 128 characters
- Mutation entries per call: 1,000; evidence path: 4,096 characters; evidence text: 16,384 characters
- Git records per call: 8
- Diffs: 1 MiB per diff, 4 MiB scanned per call, 128 per-file results
- Stats evidence: run id 128 characters, anchor call id as any tool call id, counts bounded per field

Oversized values are dropped, never truncated into a claim.

## Extension points

### Adding a tool

1. Add a rule in `tool-presentation-rules.ts`: route (`compact`, `native-live`, `live-card` or `kept-row`), audit kind, argument and result shapes, describer.
2. If it needs its own row grammar, add it in `render.ts` (see the vibe tools).
3. Without a rule, the tool still gets omp's one-row summary, so this step is optional.

### Adding a display mode

1. Extend `CompactMode` in `config.ts` and the cycle in `display-cycle.ts`.
2. Add its rows to the tables in `render-decision.ts` and `terminalPhase` in `turn-ledger.ts`.
3. Cover it in `docs/tests/integration-runs.test.ts`.

## References

- omp `docs/extensions.md`, section "Transcript presenter"
- [Configuration](CONFIGURATION.md)
- [Contributing](CONTRIBUTING.md)
