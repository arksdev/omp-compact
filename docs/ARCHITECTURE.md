# Architecture

This document describes the internal architecture of omp-compact.

## Overview

**omp-compact** is a presentation-only plugin. It wraps TUI component rendering without modifying tool execution, schemas, approval, or results.

Stock OMP handles all tool execution. The plugin observes results and decides what to show.

---

## Module Structure

```text
omp-compact/
├── .omp-plugin/                   # Marketplace catalog and production TypeScript
│   ├── marketplace.json
│   ├── index.ts                   # Plugin entry point
│   ├── runtime-adapter.ts         # Host orchestration, event hooks
│   ├── presentation-patches.ts    # Exact-instance descriptor-patch registries
│   ├── runtime-session-state.ts   # Ledgers, tool states, projections
│   ├── rebuild-lifecycle.ts       # Branch hydration and rebuild generations
│   ├── component-binding.ts       # toolCallId ↔ component mapping
│   ├── turn-ledger.ts             # Per-run entry accumulation
│   ├── render-decision.ts         # Compact vs native decision tables
│   ├── render.ts                  # Row construction (mutations, git, stats)
│   ├── render-scrape.ts           # Scraping of stock component views into views
│   ├── host-surface.ts            # Pinned stock host surface sheet (methods, fingerprints, args)
│   ├── tool-presentation-rules.ts # Rules registry: routes, aliases, shapes, lookups
│   ├── tool-rule-describers.ts    # Describer library backing the registered rules
│   ├── vibe-cards.ts              # Re-export entry point for vibe cards
│   ├── vibe-cards-decode.ts       # Defensive decoding of untrusted vibe payloads
│   ├── vibe-cards-render.ts       # Compact worker-session row rendering
│   ├── vibe-cards-slots.ts        # Slot formatters for compact vibe rows
│   ├── display-cycle.ts           # Shortcut cycle, chord validation, status line
│   ├── settings-keys.ts           # Raw key codes and arrow normalization
│   ├── host-api.ts                # Host API types; command/shortcut registration
│   ├── ansi-width.ts              # ANSI-SGR-safe strip/truncate
│   ├── save-flow.ts               # Host bridge apply → JSON persist → reload
│   ├── cycle-handler.ts           # Display-cycle keypress handler
│   ├── settings-dialog.ts         # TUI settings dialog
│   ├── settings-ui.ts             # Re-export entry point for the settings modules
│   └── …                          # Remaining production modules
├── docs/
│   ├── tests/                     # Unit/integration tests and replay corpus
│   └── assets/                    # Documentation images
├── README.md / README.en.md
├── CHANGELOG.md / LICENSE
└── package.json / bun.lock / tsconfig.json / .gitignore
```

---

## Core Abstractions

### TurnLedger (turn-ledger.ts)

A **logical run** from `agent_start` to terminal `agent_end`.

**Lifecycle:**
1. Created by `RuntimeSessionState.beginRun()`
2. Accumulates `LedgerEntry[]` while `phase === "working"`
3. Freezes on finalization with retention policy applied
4. `phase` becomes `"filtered"` or `"full"`

**Retention policy:**
- `mode === "compact"` → full log preserved
- `mode === "live"` → entries filtered by `retention: "mutation" | "git"`
- `mode === "clear"` → entries filtered but with different display rules

**Key methods:**
- `addEntry(entry)` — adds entry while working
- `finalize(mode, event)` — applies retention, sets phase
- `retainedEntries()` — returns filtered subset based on policy

---

### RuntimeSessionState (runtime-session-state.ts)

Session-scoped state manager. Owns:

**Core collections:**
- `#ledgers: TurnLedger[]` — sequence of logical runs
- `#states: Map<toolCallId, ToolState>` — all tool calls in session
- `#pendingStates: Set<ToolState>` — in-flight subset for spinner
- `#terminalProjections: Map<TurnLedger, TerminalProjection>` — aggregate Git hashes per finalized run
- `#liveStatsLines`, `#hydratedStatsEvidence` — stats row placement guards

**Lifecycle methods:**
- `beginRun()` — creates new ledger, bumps it
- `endRun(AgentEndEvent)` — finalizes ledger, retires pending states
- `hydrateBranch()`, `beginRebuild()`, `commitRebuild()` — entry points that delegate to `RebuildLifecycle` (see below); the class keeps the mutable stores, the lifecycle module owns the walks
- `dispose()` — clears all maps

**Tool state management:**
- `createToolStart(input)` — new tool call, adds to pending set
- `updateToolArgs(input)` — update args, mark pending
- `updateToolResult(input)` — update result, unmark pending if final
- `finalizeToolResult(input)` — settle tool, remove from pending

**Key invariants:**
- One active ledger at a time (the working one)
- Historical ledgers frozen after finalization
- Pending set subset of states map
- Generation bumps invalidate old rebuild callbacks

---

### RebuildLifecycle (rebuild-lifecycle.ts)

Branch hydration and rebuild generations, extracted from `RuntimeSessionState`
so the walks are reviewable in isolation.

- `hydrateBranch(entries)` — session_start replay: parses typed branch entries into ledgers/states, hydrates persisted evidence, reinserts stats carriers
- `beginRebuild()` — bumps generation, snapshots active working ownership, retires historical bindings
- `commitRebuild(snapshot, options)` — generation-guarded settlement: merges branch states into preserved active ownership, binds rehydrated components

One shared `#walkBranch` serves both replay and commit; a pure replay passes no
active ledger, a rebuild commit passes the preserved one. The seam back into
session state is the `RebuildLifecycleAccess` interface, built inside
`RuntimeSessionState` over its private fields — the class's public surface is
unchanged by the extraction.

---

### ComponentBinding (component-binding.ts)

Bidirectional map between TUI components and plugin state records.

**Binding strategies:**
1. **Exact binding** — `toolCallId` known, direct map via `#componentStates`
2. **Group discovery** — read group with `observedIds`, tracked via `#groupStates`
3. **Deferred binding** — hydrated branch, no toolCallId yet, bind by order via `tryBindByOrder()`
4. **Observed-id claim** — a rebuilt card announces its real `toolCallId` through `updateResult(result, isPartial, id)` before the branch walk recreates its state; the id waits in `#observedToolIds` and is claimed by `#bindObservedToolIds()` at the head of hydration pairing. Exact ownership, so it needs no order/suffix permit and covers rebuild triggers stock exposes no event for (`/shake`, a cancelled submission, a dropped prompt, an extension repaint). Cards whose result never replays with an id — pending, background, collapsed read groups — still depend on the permit paths.

**Read-group all-or-nothing invariant:**

A stock read group is one native card. Compact rows are built only from
plugin `ToolState`s that the group has claimed. `groupCompletelyMapped`
(and the first rule of `decideReadGroupRender`) require **every** id the
group observed through `updateArgs` / `updateResult` / `renameEntry` to
resolve to a read state mapped to *this* group. One untracked observed id
keeps the **entire** group on the raw native renderer in every phase
(working, filtered, full) — permanently for that incomplete observation
set.

This is intentional. Partial compact binding would either hide an
untracked native entry or misattribute another state's path/result.
Native is always an acceptable fallback; wrong is not. The rule also
covers the host `renameEntry ""→realId` race: until the real id resolves
to a mapped read state, the group stays native rather than rendering a
partial compact list. Do not relax this into per-entry compact rows.

**Lifecycle:**
- `bind(component, state)` — establish exact binding
- `bindGroup(component, group)` — bind read group
- `reset(generation)` — discard historical bindings, retain working ownership
- `dispose()` — clear all maps

**Key methods:**
- `stateOf(component)` — lookup state for component
- `groupOf(component)` — lookup group for component
- `tryBindByOrder(component, ledger)` — deferred binding fallback
- `groupCompletelyMapped(group)` — all-or-nothing compact gate

**Generation guards:**
- `generation` field tracks current rebuild cycle
- `reset()` discards bindings from old generations
- Working ownership snapshot preserved across rebuilds


---

### RuntimeAdapter (runtime-adapter.ts)

Host orchestrator. Installs and manages patches.

**Patches installed:**
1. **`transcript.clear`** → `#onTranscriptClear()` — rebuild boundary
2. **Component `.render()`** → `#renderBlock()` — decision + row construction
3. **Discovery patches** on containers → auto-bind new components

**Generation guards:**
```typescript
#beginRebuild(): void {
    const token = this.#session.beginRebuild();
    this.#pendingGeneration = token;
    // Schedule settlement in microtask
}

#settlePendingRebuild(): void {
    const generation = this.#pendingGeneration;
    if (this.#disposed || this.#pendingGeneration !== generation) return;
    // Commit rebuild
}
```

**Protection:**
- Generation token guards settlement callbacks after rebuild
- Ambiguous toolCallId binding → per-component native quarantine (`#quarantineComponent` / `releaseToNative`); session stays compacting
- `#rollback()` on host-invariant failure → full dispose, warn once
- Disposed adapter no-ops on all events

**Spinner:**
```typescript
#startSpinner(): void {
    this.#timer = this.#timers.setInterval(() => {
        let pending = false;
        for (const state of this.#session.pending()) {
            if (state.ledger.phase !== "working" || !state.component) continue;
            // `clear` renders no compact rows; stock surfaces animate
            // themselves, so hidden rows must not churn renders.
            if (this.#session.modeFor(state.ledger).mode === "clear") continue;
            pending = true;
            state.version++;
            this.#ui.requestComponentRender?.(state.component);
        }
        if (pending) this.#ui.requestRender?.();
    }, 80); // 12.5 Hz
}
```

### Presentation Patches (presentation-patches.ts)

Exact-instance registry for the descriptor patches `RuntimeAdapter` installs on host components — per-component render/method wraps, transcript `addChild`/`clear` wrappers and the discovery tree-watcher patches — plus their teardown.

**Two teardown scopes, deliberately:**
- `restorePerComponent()` is the detach scope: per-component patches are restored to native and cleared so retired component instances can be collected; the transcript's own patches survive — they define the rebuild boundary.
- `restoreTranscript()` / `restoreDiscovery()` are dispose-only: recorded so a failing clear probe still rolls the adapter back transactionally; discovery restore also runs when a transcript is found (the watcher's job is done).

The per-component restore runs from one shared list, so a new patch kind cannot leak patched components across a rebuild.

---

## Decision Flow

### Render Decision (render-decision.ts)

Pure decision tables map `(route, phase, mode, state)` → `ToolRenderDecision`.

**Decision outcomes:**
- `"tool-rows"` — show compact rows
- `"native"` — show native TUI component
- `"empty"` — hide completely

**Decision table (simplified):**
```
1. Unknown tool → native (fail-open)
2. native-live → native (every mode × every phase; interactive stock chrome such as ask)
3. compactSuppressedBySettings → native (the user switched this tool family's compact rows off)
4. clear + isAnchor + hashes > 0 → tool-rows (summary only: the aggregate commit line survives, terminal phases only)
5. clear → empty (every phase, abort/error included)
6. filtered + no mutations + no hashes → empty
7. working + live + no retainGitLive + hasGit → empty
8. working + expanded + !compactOnExpand → native (inspection escape hatch for ordinary compact tools)
9. filtered → tool-rows (retention policy applied)
10. Fallback → tool-rows (full log)
```

**Key insight:** First matching rule wins. Order is critical. `native-live` is phase- and mode-independent: a settled run never hides or collapses interactive stock chrome. `compactSuppressedBySettings` is plain data derived by the caller — the module never learns tool names; `runtime-adapter.ts` pairs the tool name with the run's frozen `compactVibeRows` snapshot (`VIBE_OPS` in `render.ts` stays the single source of truth for the five worker-session names).

---

## Mutation Audit

### Write Verification (audit.ts)

There is no `verifyWriteMutation` helper. Write evidence is produced by the audit pair wired through `AuditLifecycle` (`audit-lifecycle.ts`):

```typescript
// Pre-image at tool_execution_start (sync read — must not lose the race).
export async function captureWriteCandidate(input: {
    toolCallId: string;
    args: unknown;
    cwd: string;
}): Promise<MutationCandidate | undefined>;

// Post-image + line diff at tool_execution_end.
export async function completeWriteCandidate(
    candidate: MutationCandidate | undefined,
    result: unknown,
    isError: boolean,
): Promise<MutationMessageDetails[]> {
    // Require non-error result with absolute details.resolvedPath.
    // Canonical-path triple-check: snapshot path, resolved path, and
    // completion-time canonical must agree (symlink/race defense).
    // Equal bytes → no evidence. Otherwise trimmed-middle + exact line diff.
    // Returns [{ version: 1, toolCallId, toolName: "write", path, added, removed, exact: true }]
    // or [] when evidence is missing/untrusted.
}
```

**Evidence required:**
- Pre-image text snapshot taken synchronously on start
- Post-image text after end, only when paths canonicalize to the same target
- Exact line-level `added` / `removed` (not byte size/mtime guesses)

**Fallback:** Missing candidate, path mismatch, identical bytes, or over-budget diffs yield no mutation entries (`[]`); rows are not retained on invented stats.

**Path confinement (POSIX-only):** Pre-image reads and config-path acceptance
share one predicate (`path-inside-root.ts` `isPathInsideRoot`). Both sides must
be `/`-absolute; segment-exact prefix checks reject `/foo/barbaz` under
`/foo/bar`. Windows-style absolutes fail closed (no overwrite evidence; config
path rejected) — the plugin does not implement Windows path semantics.
Overwrite pre-image and post-image opens both use `O_NOFOLLOW` on the
already-confined destination (plain path, or one-hop symlink destination /
completion-time realpath'd `effectiveResult`); a concurrent swap-to-symlink
drops evidence fail-closed rather than following outside the root. Nested
symlink hops are rejected by `lstat` on the first destination.

**Device dispatches are not file writes:** a `write` whose target is an
`xd://<device>` URL executes a mounted tool, so `resolveToolAudit`
(`tool-presentation-rules.ts`) downgrades its effective audit kind from
`"write"` to `"none"` and the lifecycle never opens a write record for it —
routing it into the write path would attribute a local file mutation to a
device invocation. The device grammar comes from the stock parser
(`parseXdUrl`), so a bare `xd://` root or a path-bearing device URL is not a
device name and keeps the ordinary write kind; `audit.ts`'s own URI-scheme
guard remains the second line of defence, refusing such a target before any
filesystem access.


### Edit Verification (audit-diff.ts)

```typescript
export function countUnifiedDiff(
    diff: string,
): { added: number; removed: number } | undefined {
    // Budget-bounded scan; only lines inside well-formed @@ hunks count.
    // Malformed headers or overflow → undefined (fail open, no approximate counts).
}

export function completeEditMutations(
    toolCallId: string,
    result: unknown,
    _isError: boolean,
): DeleteMutationEvidence[] {
    // Prefers details.perFileResults; falls back to single-path details.diff / delete.
}
```

**Evidence required:**
- Native `diff` or `perFileResults` on the tool result
- Only `@@` hunk body lines counted (`+` / `-`, not file headers)
- Per-file success tracked even for multi-file operations

**Fallback:** If diff unavailable or over budget, no exact counts; deletes may still surface as count-less (`exact: false`) rows when the path is valid.

---

## Git Detection

Conservative parsing of already-executed Bash results. No hidden probes.

### Commit Summary Extraction (git-records.ts)

```typescript
function commitSummary(
	resultText: string,
): { hash: string; subject: string } | undefined {
	// Scans up to 8 lines within MAX_RESULT_SCAN_LENGTH (8192 bytes)
	// Matches COMMIT_SUMMARY_LINE banner: [branch (root-commit) hash] subject
	// Fails closed if multiple banner-shaped lines appear (ambiguous hook output)
	const match = COMMIT_SUMMARY_LINE.exec(line);
	if (!match) return undefined;
	const hash = match[1];
	const subject = match[2];
	if (hash === undefined || subject === undefined) return undefined;
	return { hash, subject: oneLine(subject) };
}
```

**Quiet commits** (`git commit -q`) print no banner. The hash then comes from a
`git log` invoked immediately after the commit in the same chain: `git log`
prints HEAD first, HEAD after a successful commit is that commit, and the
attribution is taken only when the leading captured line carries a hash plus
exactly the committed subject. A `git log` before the commit fails the proof
closed — it may have printed the pre-commit HEAD.

**Accepted shell text:** `&&`/`;` separators, one leading `cd <path> &&`, brace
lists inside a word (`src/{a,b}`, kept verbatim and never expanded), and a
double-quoted `$(printf …)`/`$(echo …)` carrying one literal argument. Every
other construct that could expand or add a command fails the whole chain
closed.

**Recognized commands:**
- `git commit` (with hash extraction)
- `git status`, `add`, `push`, `switch`, `rebase` (during work only)

**Terminal projection:**
```typescript
interface TerminalProjection {
    hashes: readonly string[]; // Chronological order
    summary: string;            // "git commit: hash1, hash2"
}
```

**Retention in `live` mode:**
- Individual Git rows removed
- Aggregate summary with verified hashes only
- Failed commits excluded

---

## Configuration

### Bounded Parsing (config.ts)

```typescript
type BoundedParseResult =
	| { readonly ok: true; readonly raw: unknown }
	| { readonly ok: false; readonly reason: string };

function parseBoundedJson(
	text: string,
	warn: (message: string) => void,
): BoundedParseResult {
	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
		const reason = `config JSON is oversized (max ${MAX_CONFIG_BYTES} bytes)`;
		warn(`${reason}; using defaults`);
		return { ok: false, reason };
	}
	// Linear scan counts bytes and nesting depth before JSON.parse without allocating
	// depth > MAX_CONFIG_DEPTH or depth < 0 returns { ok: false, reason }
	try {
		return { ok: true, raw: JSON.parse(text) as unknown };
	} catch {
		const reason = "config JSON is malformed";
		warn(`${reason}; using defaults`);
		return { ok: false, reason };
	}
}
```

**Limits:**
- Max file size: 65,536 bytes
- Max nesting depth: 16
- Invalid fields → defaults
- One warning per load

### Atomic Update Queue (keyed-queue.ts, config.ts)

```typescript
export function createKeyedQueue<K>(): <T>(
	key: K,
	operation: () => Promise<T>,
) => Promise<T>;

// Instantiated per namespace in config.ts and save-flow.ts:
const withUpdateQueue = createKeyedQueue<string>();
```

**Concurrent update flow (same process):**
1. Agent A calls `update({ mode: "compact" })`
2. Agent B calls `update({ stats: { enabled: false } })`
3. Both queued on same path
4. A: read config, derive patch `{ mode: "compact" }`, reread, apply, write
5. B: read config (with A's mode), derive patch `{ stats: { enabled: false } }`, reread, apply, write
6. Final config has both changes

**Key:** Leaf-level patch merge preserves concurrent in-process edits to different fields. The queue is in-process only (no lock file): writers in separate OS processes still race on the same JSON path, and the last successful atomic rename wins for any overlapping leaf.

### Display-Cycle Shortcut (display-cycle.ts, cycle-handler.ts)

One chord (`alt+c` by default, stored as plain text in `displayCycleKey`) walks the persisted `enabled`/`mode` pair through four states:

```text
{enabled: true,  mode: compact}
  → {enabled: true,  mode: live}
  → {enabled: true,  mode: clear}
  → {enabled: false, mode: clear}   // mode preserved
  → {enabled: true,  mode: compact} // never resurrects the stored mode
```

`mode` moves only between the three enabled steps; `enabled` flips only into and out of the off step. Re-entering at `compact` rather than the stored mode keeps the cycle order independent of where the user joined it.

**Persistence path:** the keypress handler (`cycleDisplayState`) goes through `saveSettingsFlow`, the same seam the dialog uses, so it inherits per-store serialization, host-bridge ordering, and env-mask reporting. It suppresses the flow's own success notification and emits exactly one status line instead. A hard `OMP_COMPACT_PLUGIN`/`OMP_COMPACT_MODE` override is reported as the effective state, never written over silently.

**Two host constraints shape the design:**

1. `ExtensionAPI` exposes `registerShortcut` with **no** counterpart for removal, so the chord cannot be rebound on a live session. A chord change is reported through the same `restartRequired` channel already used for thinking-block visibility. The chord is therefore read synchronously at registration (`readDisplayCycleKeySync`) — the async store would resolve after the host has already collected the extension's shortcuts.
2. The runtime's reserved-chord list is a **private class field** and unreadable at runtime; a conflicting registration is dropped with only a log line. `RESERVED_SHORTCUTS` is a version-annotated copy, pinned by a test, and validation refuses an occupied chord rather than letting the key silently die. The public default keymap (`KEYBINDINGS`) is read live and never copied. See `context/display-cycle-reserved-copy.md`.

The status line colors only the mode name (theme role `success`); `off` is intentionally left unstyled and worded differently (`from the next run` versus `takes effect next run`) so disabling the plugin does not read as another mode swap. ### Settings UI Surface (settings-ui.ts)

`settings-ui.ts` is the caller-facing entry point: it re-exports every name the settings surface exposes — key codes, host API types, ANSI utilities, the save flow, the display-cycle keypress handler and the dialog — from six focused modules (`settings-keys.ts`, `host-api.ts`, `ansi-width.ts`, `save-flow.ts`, `cycle-handler.ts`, `settings-dialog.ts`). The split is pure movement: importers of `settings-ui` resolve the same names and types; the module itself holds no logic.

---

## Lifecycle Diagrams

### Normal Run

```
agent_start
  ↓
RuntimeAdapter observes event
  ↓
RuntimeSessionState.beginRun() → creates TurnLedger
  ↓
Tools execute (native OMP)
  ↓
RuntimeAdapter observes tool events
  ↓
RuntimeSessionState updates ToolState, adds LedgerEntry
  ↓
Components render → RuntimeAdapter.#renderBlock() decides compact/native
  ↓
agent_end with final answer
  ↓
RuntimeSessionState.endRun() → ledger.finalize(mode, event)
  ↓
Retention policy applied
  ↓
Filtered rows removed, mutations/Git/stats retained
```

### Rebuild (e.g., /tree navigation)

```
User navigates /tree
  ↓
Transcript clear event
  ↓
RuntimeAdapter.#onTranscriptClear()
  ↓
RuntimeSessionState.beginRebuild() → bumps generation
  ↓
Pending generation token stored
  ↓
Microtask scheduled for settlement
  ↓
Hydrated branch arrives
  ↓
ComponentBinding resets, discards historical bindings
  ↓
Components discovered, bound by order
  ↓
Microtask fires
  ↓
Generation guard checks token
  ↓
If match: commitRebuild() → validates, binds
  ↓
If stale: abort (another rebuild started)
```

### Continuation Run

```
Previous run finalized
  ↓
agent_end with willContinue: true
  ↓
RuntimeSessionState does NOT finalize ledger
  ↓
Ledger remains in working phase
  ↓
More tool calls added to same ledger
  ↓
Eventually terminal agent_end (willContinue: false)
  ↓
RuntimeSessionState.endRun() → ledger.finalize()
  ↓
Retention policy applied to entire continuation chain
```

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `createToolStart` | O(1) | Map insert |
| `updateToolResult` | O(1) | Map lookup + update |
| `pending()` | O(N) | Snapshot copy of pending set |
| Spinner iteration | O(N) | 12.5 Hz, N = pending count |
| `reset()` | O(M) | M = total component bindings |
| `finalize()` | O(E) | E = ledger entries, applies filter |

### Memory Retention

Successful filtered runs retire their heavy raw payloads (`args`, `result`, and per-call Git records) only after materializing an immutable terminal projection. The remaining lightweight state/projection records are retained while the current transcript must still support resize, replay, and reconstruction, then released on rebuild or session disposal.

Session-wide growth is therefore linear in retained transcript history, not a demonstrated cross-session leak:

- `#states`: O(mapped tool calls retained by the current transcript)
- `#pendingStates`: O(concurrent tools)
- `#terminalProjections`: O(finalized runs needed for immutable terminal rendering)
- hydrated stats evidence: transient during reconstruction and cleared after placement

Measured on Bun 1.3.14 (darwin arm64) by driving the real `RuntimeSessionState` public API (`startState` / `finishTool` / `setMutations` / `setGit` / `endRun` / `finishFull` / `retireFilteredPayloads`) — not a model of `#states`. Primary metric: `live = heapUsed + external` after `Bun.gc(true)` (JSC parks large strings outside `heapUsed`, so heap alone under-reports retained payloads). Fresh-process RSS was a cross-check only. Payload mix approximated a coding-agent session (mostly small reads/bash, with a real tail of ~120 KiB reads, multi-line greps, writes/edits with mutation evidence, and git rows). Host UI component trees and the adapter's seven patch Maps were out of scope (those are O(installed components), not O(mapped calls)). The profile exercises plugin-internal state and does not depend on the stock host pin (measured under whatever `node_modules` was present; host was pinned to OMP 17.3.8 in-tree at the same time).

| Mapped calls (N) | Retained (`full`, payloads kept) | Retired (`filtered` + retire) | Skeleton floor (tiny + retired) |
|------------------|----------------------------------|-------------------------------|---------------------------------|
| 1k | 22.2 MiB (~22 KiB/call) | 3.59 MiB (~3.5 KiB/call) | 3.20 MiB |
| 10k | 325 MiB (~32 KiB/call) | 10.3 MiB (~1.0 KiB/call) | 9.27 MiB |
| 100k | 3.33 GiB (~33 KiB/call) | 70.6 MiB (~690 B/call) | 62.9 MiB |

At large N, retirement reclaims ~97% of the retained live set (about 47× at 100k). After retirement, ~89% of what remains is the skeleton floor: the residual is `ToolState` / ledger / Map overhead, not payload fat. A heavy interactive day (low thousands of calls, nearly all filtered) sits in the single-digit MiB range; 100k success-path calls are still ~70 MiB. The multi-gigabyte figure appears only if payloads stay retained (`full` / abort / never-filtered) at extreme N — not the production success path.

Limits of the figure: synthetic mix rather than a captured production session; RSS is a noisier upper bound (allocator fragmentation after freeing large transient strings); trial medians, not a single sample. These numbers do not justify an eviction policy for ordinary single-tenant sessions.

Any future eviction policy must still preserve Git summaries, resize rendering, `/tree`, and `/shake`; deleting projections during payload retirement would lose required terminal evidence.

---

## Safety Mechanisms

### Fail-Open Design

Binding data conflicts quarantine one surface:

```typescript
#quarantineComponent(component: RenderableBlock): void {
    this.#session.binding.releaseToNative(component);
    // restore this component's host patch; leave the session installed
}
```

Host-invariant failures still trigger complete rollback:

```typescript
#rollback(message: string): void {
    try {
        this.#warn?.(message);
    } catch {}

    this.dispose(); // Remove all patches, clear state
    this.#onDisabled?.(); // index clears handle + marks session native
}
```

**Error sources (session-wide `#rollback`):**
- Incompatible TUI shape / unpatchable core surface
- Multiple transcript containers
- Unexpected host exception during discovery/patch / presentation settle

**Owner policy:** mid-session `#rollback` is **session-terminal**. The adapter fires `onDisabled` once after `dispose()`; `index.ts` drops its live handle and sets `adapterDisabled`. A dead adapter is never handed to event handlers, and the runtime does **not** reinstall until a session boundary (`session_before_switch` / `session_shutdown` → `dispose` resets the flags). Reinstall is refused because host-invariant causes almost certainly recur immediately — an unbounded retry would warn/rollback-loop on every event, which is worse than staying native.

**Error sources (per-component quarantine):**
- Ambiguous provisional→real toolCallId migration
- Dual-group / cross-surface id ownership conflict

**Outcome:** OMP continues with native renderer on the affected surface (or fully native after rollback). Session never crashes.

### Capability Checks

Before installing patches:

```typescript
// transcript-fold.ts
function isRenderableBlock(value: unknown): value is RenderableBlock {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as RenderableBlock).render === "function",
	);
}
```

A callable `render` is the whole requirement, matching `RenderableBlock`
(`render(width): Lines`). No stock leaf exposes a `lines` property, so
demanding one would reject every component and fall back to native
everywhere.

**If check fails:** Installation rolls back, native renderer used.

### Bounded Inputs

All external inputs bounded:

- Config file: `MAX_CONFIG_BYTES` 65,536 bytes, `MAX_CONFIG_DEPTH` 16
- Tool result payload: `MAX_PAYLOAD_BYTES` 1 MiB (1,048,576 bytes)
- Tool name: `MAX_TOOL_NAME_LENGTH` 128 chars
- toolCallId: `MAX_TOOL_CALL_ID_LENGTH` 256 chars
- Mutation entries: `MAX_MUTATION_ENTRIES` 1,000 max

**Outcome:** DoS-resistant. Oversized inputs rejected with warning.

### Host-trusted agent directory

The host-supplied agent directory and the live session `Settings` object sit
**inside** the plugin's trust boundary — the same premise as the host's own
`setAgentDir` / `DirResolver` (no home gate on the override):

- **Trusted inputs.** `PI_CODING_AGENT_DIR` (via host `setAgentDir`) and
  `Settings.getAgentDir()` name the profile tree the host already chose for
  this session. The plugin does not re-confine either path to `$HOME` or the
  project cwd.
- **What follows.** Plugin JSON is resolved under
  `<agentDir>/omp-compact/config.json` (`config.ts`); the host-YAML pre-image
  for settings rollback is read from `<getAgentDir()>/config.y{a}ml`
  (`host-settings.ts`). Both locations are host-controlled.
- **Still bounded.** YAML pre-image reads keep a byte budget
  (`MAX_HOST_SETTINGS_YAML_BYTES`); an unreadable or over-budget pre-image
  fails the host-settings update closed before any `set()`/`flush()`. Depth
  needs no separate budget: indentation makes block nesting grow
  quadratically, so 64 KiB already caps it, and flow nesting deep enough to
  exhaust the parser raises a `RangeError` that the same fail-closed catch
  turns into a rejection.
- **Why confinement was rejected.** Gating the host agent dir to home/cwd
  would silently fall through to stock defaults and drop the user's settings
  (containers, system prefixes, harness temp dirs are legitimate overrides).
  That silent-loss failure mode is worse than trusting the host-owned path.

---

## Compatibility and Capacity Notes

- **Two version numbers, different jobs.** `package.json` `engines.omp`
  (`>=18.0.1`) is the public floor (release metadata — do not edit it from a
  code-review pass). `marketplace.json` carries plugin version/description only.
  `StockHostAdapter.hostVersion` (`18.1.4`) records the
  **verified** critical private-surface contract the adapter was written
  against. Comments that cite `17.3.1`/`17.3.4` mark optional leaf fingerprints confirmed on those
  hosts. Neither string is a runtime gate — every decision is a live
  capability probe (`isToolComponent`, `isTodoReminderComponent`,
  `transcriptCapabilities`, …).
- **What is verified where.** Critical tool / read-group / transcript / TUI
  shapes: written against 17.3.1 and re-verified on the current pin 18.1.4.
  Optional compact chrome (TTSR inject, todo reminder, skill card, late
  diagnostics, user `!`/`$` execution): method fingerprints checked against
  17.3.1 and/or 17.3.4 sources in the local bun cache (and exercised under
  the 18.1.4 gate). On 17.2.12 the same cache shows TTSR / todo-reminder /
  late-diagnostics **without** `setToolActivityVisible`, so those
  fingerprints miss and the stock card stays native (no misclassification
  into tool paths). User bash/eval and skill surfaces are present on
  17.2.12; their compact path still fails open to native when content
  extraction fails.
- **What 18.0.1 changed in the transcript.** The container replaced its
  native-scrollback live region with explicit block lifecycle states
  (`active` → `settled` → `committed`) plus history batches the terminal
  acknowledges. `renderViewportTail`, `isBlockUncommitted` and
  `isBlockInLiveRegion` are gone (`renderViewport`, `canRemoveBlock`,
  `liveRowCount`, `peekFinalizedBatch`, `acknowledgeFinalizedBatch`,
  `blockStates` took their place), and the per-block row accounting a live
  region needed (`getTranscriptBlockVersion`,
  `getTranscriptBlockSettledRows`, `setNativeScrollbackCommittedRows`) has
  no consumer left. The fold therefore replans on four render entry points
  instead of two, a carrier's `seal` freezes its whole run (retirement is
  batched, not row-counted), and the committed-row gate for the scrollback
  replay reads `blockStates()` by child position. Because the critical
  fingerprint moved, a build for 18.0.0 finds no transcript host from 18.0.1
  on and vice versa: the plugin stays fully native instead of guessing, which
  is why the public floor moved with that rewrite. Every release from 18.0.2
  through 18.1.4 left the whole critical surface untouched — the container
  only exported its own `trimBlankEdges` helper, the inline tool card gained
  styling plus a trimmed-height check before degrading under a squeezed
  allocation, the transcript gained an append-only surface, 18.0.7/18.0.8
  left the container and the tool card byte-identical while adding the stock
  usage row's own prompt→yield delta, and 18.0.9/18.0.10 left them
  byte-identical too, with 18.0.10 adding only a retry-replay path (reused
  `toolCallId`s evict the stale prior-turn card), the `syncRetryHintRow`
  hint row and an `f5` default for `app.retry`, while 18.0.11 through 18.1.3
  left the read group byte-identical and the tool card semantically unchanged,
  added only frame-recovery and row-map helpers to the container, and left the
  `rebuildChatFromMessages()` call-site set intact. 18.1.4 shipped
  `@oh-my-pi/pi-coding-agent/src` and `@oh-my-pi/pi-tui/src` byte-identical to
  18.1.3 — 1729 and 50 files, `diff -rq` clean — moving only the model catalog
  (`gemini-3.8-flash` across five providers, ten refreshed entries) and the
  provider compat rules (`{rev}` revision templating), neither of which this
  plugin reads — so the floor stays at
  `>=18.0.1` while the gate pin follows the newest release.

- **Rows retire, blocks fill the screen.** The container retires history by
  rows, but its pressure fallback keys on block count: past the transcript
  height it prints each live block's first row, and a folded member has none.
  Folding shrinks rows without shrinking blocks, so the fold does two things.
  It reports the live tail's own height (minus one row) as the room for a
  history batch while blocks outnumber rows, which keeps retirement making
  progress every frame instead of stalling as soon as the rows happen to fit.
  And when the fold itself is the reason the count is inflated, it answers for
  the frame: blocks that render nothing take no row, the rest render whole, and
  the newest rows win the screen. An open run is never settled, so retirement
  alone could never rescue a single long turn holding more blocks than the
  screen has rows. The live boundary comes from `canRemoveBlock`, which also
  excludes a batch already offered but not yet acknowledged, so no row is
  painted twice.

- **History leaves by two doors, and the replay gate must know both.** The
  container writes rows above the viewport either by retiring a settled block
  or by publishing the stable prefix of an append-only block that is still
  reported `active` — a streamed answer does the latter one row per frame. Both
  are frozen native output, so the terminal replay seam fires on either: the
  fold records every history batch handed over through its own wrapper, which
  is what a lifecycle state cannot show. Gating on a retired carrier alone left
  a long answer with no tool calls without its replay, and its leading rows
  stayed unreachable. The gate is not dropped altogether because `resetDisplay`
  replays the entire committed ledger and blocks on PTY backpressure; short
  turns with nothing above the viewport must not pay for it.

- **The 18.0.6 replay entry point is optional, not critical.** That release
  routes complete-history replay through `peekReplayBatch`, driven from
  `resetDisplay` with no frame in between, so the fold wraps it and replans
  first — otherwise a carrier answers with the rows of a run that has since
  grown, and members added after the last frame render native cards straight
  into scrollback. It stays out of the critical fingerprint because the floor
  is `>=18.0.1`, where the method does not exist; patching only what an
  instance really has also keeps the capability probe honest.

- **Older host outcome.** Unverified or missing surfaces remain native —
  the user loses some compaction chrome, not a wrong compact row. Ordinary
  compact tools may use expanded as a native inspection escape hatch;
  browser, computer, resolve, and reject explicitly remain compact when
  expanded. A future host-shape break is handled fail-open and becomes a
  compatibility issue to reproduce and add explicitly.
- **Floor recommendation (not applied here).** If release wants every
  optional fingerprint to be a verified match rather than a clean probe
  miss, raise the public `package.json` `engines.omp` floor to `>=17.3.1`.
  That is release metadata via `engines.omp`, not an adapter change.
- The spinner samples pending states at 80 ms while the adapter is active; profile real high-concurrency workloads before changing cadence or fairness.
- Long transcripts retain lightweight display metadata linearly with visible history. The plugin releases it on reconstruction and session disposal, while heavy filtered payloads retire after terminal projection.
- Stock-host integration contracts cover continuation, rebuild, `/tree`-like and `/shake`-like reconstruction, delayed terminal drains, and lifecycle disposal.


---

## Extension Points

### Adding a New Tool

1. Add rule to `tool-presentation-rules.ts`:

```typescript
export const TOOL_RULES: Readonly<
    Partial<Record<string, ToolPresentationRule>>
> = Object.freeze({
    // ...existing tools

    my_tool: {
        route: "compact",
        audit: "none",
        knownArgs: ["arg1", "arg2"],
        knownDetails: ["detail1"],
        describe(args: unknown): ToolDescription {
            const a1 = stringValue(record(args), "arg1");
            return { title: "my_tool", description: a1, meta: [] };
        },
    },
});
```

2. No other changes needed. Decision tables use registry lookup.

### Adding a New Display Mode

1. Add mode to `CompactMode` type in `config.ts`:

```typescript
export type CompactMode = "compact" | "live" | "clear" | "my_mode";
```

2. Update decision tables in `render-decision.ts`:

```typescript
function decideToolRender(/* ... */): ToolRenderDecision {
    // Add rules for new mode
    if (mode === "my_mode" && /* condition */) {
        return { kind: "tool-rows", filtered: false, summary: false, includeGit: false };
    }
}
```

3. Update config validation in `config.ts`.

---

## References

- [Full Documentation](FULL-DOCUMENTATION.md) — User-facing feature reference
- [Configuration](CONFIGURATION.md) — All settings and environment variables
- [Repository README](../README.md) — Russian project overview and installation ([English](../README.en.md))
- [Contributing](CONTRIBUTING.md) — Development guide
