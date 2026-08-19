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
│   ├── runtime-session-state.ts   # Ledgers, tool states, projections
│   ├── component-binding.ts       # toolCallId ↔ component mapping
│   ├── turn-ledger.ts             # Per-run entry accumulation
│   ├── render-decision.ts         # Compact vs native decision tables
│   ├── render.ts                  # Row construction (mutations, git, stats)
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
- `beginRebuild()` — bumps generation, snapshots active working ownership
- `commitRebuild()` — validates & binds rehydrated branch
- `abortRebuild()` — test/soft-abort helper: clears rebuild marker + preserved identity window for the matching generation; production adapter uses hard rollback/dispose instead
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

### ComponentBinding (component-binding.ts)

Bidirectional map between TUI components and plugin state records.

**Binding strategies:**
1. **Exact binding** — `toolCallId` known, direct map via `#componentStates`
2. **Group discovery** — read group with `observedIds`, tracked via `#groupStates`
3. **Deferred binding** — hydrated branch, no toolCallId yet, bind by order via `tryBindByOrder()`

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

**`noteTreeIntent`:** Explicit no-op seam on `RuntimeAdapter`. `session_tree` is optional intent/coalescing metadata only; the method deliberately has no side effects. Rehydration and presentation-generation bumps key off the transcript `clear` that follows a committed navigation, never this event.

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
3. clear + not-full → empty
4. filtered + no mutations + no hashes → empty
5. working + live + no retainGitLive + hasGit → empty
6. working + expanded + !compactOnExpand → native (inspection escape hatch for ordinary compact tools)
7. filtered → tool-rows (retention policy applied)
8. Fallback → tool-rows (full log)
```

**Key insight:** First matching rule wins. Order is critical. `native-live` is phase- and mode-independent: a settled run never hides or collapses interactive stock chrome.

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

### Hash Extraction (messages.ts)

```typescript
function extractCommitHash(output: string): string | undefined {
    // Match patterns like "[main a1b2c3d] commit message"
    const match = output.match(/\[[\w\-\/]+\s+([0-9a-f]{7,40})\]/);
    return match?.[1];
}
```

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
function parseBoundedJson(text: string, warn: (msg: string) => void): unknown {
    if (text.length > MAX_CONFIG_BYTES) {
        warn('Config file too large');
        return undefined;
    }

    const parsed = JSON.parse(text);

    function checkDepth(value: unknown, depth: number): boolean {
        if (depth > MAX_CONFIG_DEPTH) return false;
        if (typeof value === 'object' && value !== null) {
            for (const v of Object.values(value)) {
                if (!checkDepth(v, depth + 1)) return false;
            }
        }
        return true;
    }

    if (!checkDepth(parsed, 0)) {
        warn('Config nesting too deep');
        return undefined;
    }

    return parsed;
}
```

**Limits:**
- Max file size: 65,536 bytes
- Max nesting depth: 16
- Invalid fields → defaults
- One warning per load

### Atomic Update Queue (config.ts)

```typescript
const updateQueues = new Map<string, Promise<void>>();

async function withUpdateQueue<T>(path: string, op: () => Promise<T>): Promise<T> {
    const queue = updateQueues.get(path) ?? Promise.resolve();
    const next = queue.then(op, op);
    updateQueues.set(path, next.then(() => {}, () => {}));
    return next;
}
```

**Concurrent update flow (same process):**
1. Agent A calls `update({ mode: "compact" })`
2. Agent B calls `update({ stats: { enabled: false } })`
3. Both queued on same path
4. A: read config, derive patch `{ mode: "compact" }`, reread, apply, write
5. B: read config (with A's mode), derive patch `{ stats: { enabled: false } }`, reread, apply, write
6. Final config has both changes

**Key:** Leaf-level patch merge preserves concurrent in-process edits to different fields. The queue is in-process only (no lock file): writers in separate OS processes still race on the same JSON path, and the last successful atomic rename wins for any overlapping leaf.

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
function isRenderableBlock(component: unknown): boolean {
    return (
        component !== null &&
        typeof component === 'object' &&
        typeof (component as any).render === 'function' &&
        (component as any).lines !== undefined
    );
}
```

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
- **Still bounded.** YAML pre-image reads keep byte and nesting-depth budgets
  (`MAX_HOST_SETTINGS_YAML_BYTES` / `MAX_HOST_SETTINGS_YAML_DEPTH`); an
  unreadable or over-budget pre-image fails the host-settings update closed
  before any `set()`/`flush()`.
- **Why confinement was rejected.** Gating the host agent dir to home/cwd
  would silently fall through to stock defaults and drop the user's settings
  (containers, system prefixes, harness temp dirs are legitimate overrides).
  That silent-loss failure mode is worse than trusting the host-owned path.

---

## Compatibility and Capacity Notes

- **Two version numbers, different jobs.** `package.json` `engines.omp`
  (`>=17.2.12`) is the public floor (release metadata — do not edit it from a
  code-review pass). `marketplace.json` carries plugin version/description only.
  `HostAdapter1731.hostVersion` (`17.3.8`) records the
  **verified** critical private-surface contract the adapter was written
  against; the class name keeps the historical `1731` suffix. Comments that
  cite `17.3.1`/`17.3.4` mark optional leaf fingerprints confirmed on those
  hosts. Neither string is a runtime gate — every decision is a live
  capability probe (`isToolComponent`, `isTodoReminderComponent`,
  `transcriptCapabilities`, …).
- **What is verified where.** Critical tool / read-group / transcript / TUI
  shapes: written against 17.3.1 and re-verified on the current pin 17.3.8.
  Optional compact chrome (TTSR inject, todo reminder, skill card, late
  diagnostics, user `!`/`$` execution): method fingerprints checked against
  17.3.1 and/or 17.3.4 sources in the local bun cache (and exercised under
  the 17.3.8 gate). On 17.2.12 the same cache shows TTSR / todo-reminder /
  late-diagnostics **without** `setToolActivityVisible`, so those
  fingerprints miss and the stock card stays native (no misclassification
  into tool paths). User bash/eval and skill surfaces are present on
  17.2.12; their compact path still fails open to native when content
  extraction fails.
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
