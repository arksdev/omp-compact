# Contributing

Thank you for considering contributing to omp-compact! This guide covers development setup, code conventions, testing, and the contribution workflow.

---

## Development Setup

### Prerequisites

- **Bun 1.3+**
- macOS, Linux, or Windows capable of installing the pinned OMP package

The repository pins stock OMP 18.2.9 as its development and release-gate host while publicly supporting OMP 18.0.1 and later through capability-checked native fail-open behavior. TypeScript, Bun types, and Biome are pinned in `package.json`/`bun.lock`.

### Clone and Install

```bash
git clone https://github.com/arksdev/omp-compact.git
cd omp-compact
bun install --frozen-lockfile
```

### Running Checks

```bash
# Strict typecheck, lint, format check, and the full stock-host suite
bun run check

# Individual gates
bun run typecheck
bun run lint
bun run format:check
bun run test

# A focused file (provide the same stock binary boundary)
OMP_STOCK_BIN=./node_modules/.bin/omp bun test docs/tests/component-binding.test.ts
```

Treat the current command output as authoritative: the gate must come back with zero failures.

CI runs the same gate on every push and pull request (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`, then `bun run check`. The frozen lockfile is the part a local run cannot reproduce — a warm `node_modules` hides a drift between `bun.lock` and `package.json`. The `test` script sets `OMP_STOCK_BIN=./node_modules/.bin/omp` so stock-host integration, replay, and the host capability canaries actually execute against pinned OMP 18.1.14; `host-env-guard.test.ts` fails the run when that variable is missing, because bare `bun test …` without it reports every stock-host-dependent test as skipped and still exits zero.

Config JSON persistence uses an in-process writer queue and atomic rename only — concurrent updates from separate OS processes on the same path are last-writer-wins (no lock file). See [CONFIGURATION.md](CONFIGURATION.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

### Testing Locally

Install or link the checkout for manual testing:

```bash
# One-time isolated source launch
omp --extension /absolute/path/to/omp-compact/.omp-plugin/index.ts

# Persistent user installation from the package root
omp plugin link /absolute/path/to/omp-compact --scope user

# Restart OMP, verify with /compact-settings
```

---

## Code Conventions

### TypeScript Style

**Strict mode:** Enabled. No `any` in production code (except guarded capability checks).

**Naming:**
- Private fields: `#camelCase`
- Public fields: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`

**Example:**
```typescript
export class RuntimeAdapter {
    readonly #ui: AdapterUI;
    readonly #session: RuntimeSessionState;
    #disposed = false;

    dispose(): void {
        if (this.#disposed) return;
        this.#rollback("Manual disposal");
    }

    #rollback(message: string): void {
        // ...
    }
}
```

### Mutability

**Default to immutable:**
- Use `readonly` on class fields unless mutation required
- Use `readonly` on array/object types
- Return `readonly` arrays from public methods

**Example:**
```typescript
export interface TurnLedger {
    readonly entries: readonly LedgerEntry[];
    readonly phase: LedgerPhase;
}

function retainedEntries(): readonly LedgerEntry[] {
    return this.entries.filter(e => e.retention !== "none");
}
```

### Error Handling

**Fail-open pattern:** Any error in plugin operation rolls back completely.

**Example:**
```typescript
try {
    this.#installPatches();
} catch (error) {
    this.#rollback(`omp-compact disabled: ${String(error)}`);
    return false;
}
```

**Never throw from plugin to host.** Catch everything, log warning, dispose cleanly.

### Comments

**Explain "why", not "what":**

```typescript
// GOOD
// C02: the exact transcript `clear` is the rebuild boundary.
// Stock pre-sets `setExpanded(...)` before we can patch, so initial
// expanded state is read from host instead of guessed.

// BAD
// Sets the expanded state
this.#expanded = getExpanded();
```

**JSDoc on public API:**
```typescript
/**
 * Finalize this ledger, applying retention policy based on mode.
 * After finalization, phase becomes "filtered" or "full" and entries
 * array becomes read-only.
 */
finalize(mode: CompactMode, event: AgentEndEvent | undefined): void {
    // ...
}
```

### Module Organization

Production TypeScript lives in `.omp-plugin/`; tests, replay helpers, fixtures, and goldens live in `docs/tests/` so the repository root stays focused on public entry points and package metadata.

**One responsibility per module:**
- `.omp-plugin/runtime-adapter.ts` — host orchestration only
- `.omp-plugin/runtime-session-state.ts` — state management only
- `.omp-plugin/rebuild-lifecycle.ts` — branch hydration and rebuild lifecycle only
- `.omp-plugin/render-decision.ts` — decision tables only
- `.omp-plugin/render.ts` — row construction only
- `.omp-plugin/render-scrape.ts` — scraping stock component views into compact views only
- `.omp-plugin/host-surface.ts` — pinned stock host surface sheet (method manifests, component fingerprints, argument decoders) only
- `.omp-plugin/tool-presentation-rules.ts` — rules registry (routes, aliases, shapes, lookups) only
- `.omp-plugin/tool-rule-describers.ts` — rule description behavior (describe/resultMeta, devices, hub mirror) only
- `.omp-plugin/vibe-cards.ts` — re-export entry point only (decode/render split)
- `.omp-plugin/vibe-cards-decode.ts` — defensive decoding of untrusted vibe payloads only
- `.omp-plugin/vibe-cards-render.ts` — worker-session row rendering only
- `.omp-plugin/vibe-cards-slots.ts` — slot formatters only
- `.omp-plugin/presentation-patches.ts` — exact-instance descriptor-patch registries only
- `.omp-plugin/settings-keys.ts` — raw key codes and arrow normalization only
- `.omp-plugin/host-api.ts` — structural host API types and command/shortcut registration only
- `.omp-plugin/ansi-width.ts` — ANSI-safe width utilities only
- `.omp-plugin/save-flow.ts` — settings save flow only
- `.omp-plugin/cycle-handler.ts` — display-cycle keypress handling only
- `.omp-plugin/settings-dialog.ts` — TUI settings dialog only
- `.omp-plugin/settings-ui.ts` — re-export entry point only (logic lives in the settings modules)

**Avoid circular dependencies.** Import tree flows downward:
```
index.ts
  → runtime-adapter.ts
      → runtime-session-state.ts
          → rebuild-lifecycle.ts
          → turn-ledger.ts
          → component-binding.ts
      → presentation-patches.ts
      → host-adapter.ts
          → host-surface.ts
      → render-decision.ts
      → render.ts
          → tool-presentation-rules.ts
              → tool-rule-describers.ts
          → display-path.ts
          → render-scrape.ts
          → vibe-cards-render.ts
              → vibe-cards-slots.ts
          → vibe-cards-decode.ts
  → settings-ui.ts             # re-export entry point
      → settings-keys.ts / host-api.ts / ansi-width.ts
      → save-flow.ts / cycle-handler.ts / settings-dialog.ts
```

---

## Testing Guidelines

### Test Structure

**File naming:** `<module>.test.ts`

**Test style:** Descriptive, grouped by feature.

**Example:**
```typescript
import { describe, expect, test } from "bun:test";
import { classifyAgentEnd } from "../../.omp-plugin/turn-ledger";

describe("classifyAgentEnd", () => {
    test("returns working when willContinue is true", () => {
        const result = classifyAgentEnd({ willContinue: true, messages: [] });
        expect(result).toBe("working");
    });

    test("returns full when stopReason is toolUse", () => {
        const event = {
            messages: [{
                stopReason: "toolUse",
                content: []
            }]
        };
        const result = classifyAgentEnd(event);
        expect(result).toBe("full");
    });

    test("returns filtered when stopReason is stop with visible text", () => {
        const event = {
            messages: [{
                stopReason: "stop",
                content: [{ type: "text", text: "Done!" }]
            }]
        };
        const result = classifyAgentEnd(event);
        expect(result).toBe("filtered");
    });
});
```

### What to Test

**Required:**
- Pure functions (decision tables, parsers, formatters)
- Edge cases (empty inputs, undefined, oversized data)
- Bounded validation (config parsing, payload guards)
- Mutation audit logic
- Git hash extraction
- Stats aggregation

**Also required, and already extensive:**
- Integration tests against the real pinned host — twenty `integration-*.test.ts` suites boot the plugin into a live stock session, one per seam (`integration-transcript-rebuild`, `integration-auto-shake`, `integration-audit-mutations`, and so on) over the shared `integration-harness.ts`; `run-stats.integration.test.ts` covers the stats seam and `presentation-patches.integration.test.ts` the leaf overrides.
- Runtime adapter against real TUI components — the whole integration suite patches genuine `ToolExecutionComponent`, `ReadToolGroupComponent` and `TranscriptContainer` instances, and `host-patch-surface.test.ts` fails when the methods those patches need disappear or when a scraped leaf drifts.
- Concurrent rebuild scenarios — generation staleness, two quick clears, and mid-rebuild switches are covered in the integration suite.

A change that touches more than one module needs an integration test, as the coverage standard below states.

### Test Coverage Standards

**New features:** Must include tests covering:
- Happy path
- Edge cases (empty, undefined, null)
- Error cases (invalid input, bounds violations)
- At least one integration test if feature touches multiple modules

**Bug fixes:** Must include regression test demonstrating the bug, then fix.

---

## Contribution Workflow

### 1. Open an Issue

Describe an observable failure, the exact OMP version, reproduction steps, expected behavior, actual behavior, and any relevant terminal output. Do not report inferred leaks or private-host incompatibility as confirmed defects without a reproducible measurement.

### 2. Fork and Branch

```bash
# Fork on GitHub, then clone your fork
git clone https://github.com/arksdev/omp-compact.git
cd omp-compact

# Create a focused branch
git checkout -b fix/descriptive-name
```

### 3. Develop

Keep commits focused, preserve plugin-only execution semantics, and add a regression contract before behavior changes. Do not replace stock tools or copy native schemas/approval metadata.

**Run checks before pushing:**
```bash
bun run check
```

### 4. Open Pull Request

**PR title:** Clear, imperative mood.
- ✅ "Preserve stats carriers across delayed terminal drains"
- ❌ "Fix some display stuff"

**PR description template:**
```markdown
## Problem
Describe the observable failure and affected OMP version.

## Solution
Explain the minimal source-level correction and why native execution semantics remain unchanged.

## Testing
- Added a red/green observable contract
- Ran `bun run check`
- Performed a focused TUI smoke when presentation changed

## Checklist
- [x] Tests added and passing
- [x] Type check clean
- [x] Lint/format clean
- [x] Documentation updated when the public contract changed
```

### 5. Code Review

**Review process:**
1. Contributor runs `bun run check` (typecheck, lint, format check, and the full suite) before pushing
2. Maintainer reviews code, tests, documentation
3. Requested changes addressed
4. PR merged

**Review criteria:**
- Correctness
- Test coverage
- Code style consistency
- No breaking changes (unless major version)
- Documentation updated if needed

---

## Architecture Guidelines

### Adding a New Tool

1. Add rule to `tool-presentation-rules.ts`:

```typescript
export const TOOL_RULES: Readonly<Partial<Record<string, ToolPresentationRule>>> = Object.freeze({
    // ...existing tools

    my_new_tool: {
        route: "compact",              // or "read-group" or "native-live"
        audit: "write",                // or "edit" or "git-bash" or "none"
        knownArgs: ["path", "content"],
        knownDetails: ["resolvedPath", "size"],
        describe(args: unknown): ToolDescription {
            const path = stringValue(record(args), "path");
            return { title: "my_new_tool", description: path, meta: [] };
        },
        resultMeta(result: unknown): readonly string[] {
            const details = record(record(result).details);
            return typeof details.size === "number"
                ? [`${details.size} bytes`]
                : [];
        },
    },
});
```

2. Add tests in `docs/tests/tool-presentation-rules.test.ts`:

```typescript
describe("my_new_tool", () => {
    test("describes with path", () => {
        const desc = TOOL_RULES.my_new_tool?.describe({ path: "file.txt" });
        expect(desc?.title).toBe("my_new_tool");
        expect(desc?.description).toBe("file.txt");
        expect(desc?.meta).toEqual([]);
    });

    test("describes without path", () => {
        const desc = TOOL_RULES.my_new_tool?.describe({});
        expect(desc?.description).toBe("");
        expect(desc?.meta).toEqual([]);
    });
});
```

3. Add the name to `CANONICAL_NAMES` in `docs/tests/tool-presentation-rules.test.ts`. That list is the registry inventory, and the suite asserts the registry holds exactly it — a new rule fails the gate until the inventory grows with it. Widen the bounded coverage lists in the same file (for example the closed name list in "no other rule carries result metadata") when the new rule belongs in them.

4. No other changes are needed for an ordinary compact row: decision tables use registry lookup. A tool that needs its own row grammar rather than a `title: description` summary also gets a branch in `render.ts` ahead of the generic rule lookup, the way the `vibe_*` worker-session tools resolve through `vibe-cards.ts`.

### Adding a New Display Mode

**Not recommended** — the three existing modes cover most use cases. If you have a compelling reason:

1. Open an issue first to discuss rationale
2. Add mode to `CompactMode` type in `config.ts`
3. Update decision tables in `render-decision.ts`
4. Update config validation
5. Add comprehensive tests
6. Update documentation

### Modifying Decision Tables

Decision tables in `render-decision.ts` are ordered rule chains. **First match wins.**

**When adding a rule:**
1. Understand existing rule order
2. Place new rule at correct precedence
3. Test all affected combinations
4. Add comments explaining precedence

**Example:**
```typescript
// Order matters: most specific rules first
if (mode === "clear" && route === "native-live") return "native";  // 1
if (mode === "clear" && phase !== "full") return "empty";          // 2
if (phase === "filtered" && !hasMutations) return "empty";         // 3
// Expanded is native only for ordinary compact tools; browser/computer/
// resolve/reject opt out and remain compact.
// ... fallback rules
```

---

## Performance Considerations

### Avoid Unbounded Growth

**Bad:**
```typescript
class RuntimeSessionState {
    readonly #allEvents: Event[] = [];

    addEvent(event: Event): void {
        this.#allEvents.push(event);  // Unbounded
    }
}
```

**Good:**
```typescript
class RuntimeSessionState {
    readonly #recentEvents: Event[] = [];

    addEvent(event: Event): void {
        this.#recentEvents.push(event);
        if (this.#recentEvents.length > 100) {
            this.#recentEvents.shift();  // Bounded to 100
        }
    }
}
```

### Avoid Hot Path Allocation

**Bad:**
```typescript
#startSpinner(): void {
    this.#timer = setInterval(() => {
        const pending = [...this.#pendingStates];  // Allocates every 80ms
        for (const state of pending) {
            // ...
        }
    }, 80);
}
```

**Good:**
```typescript
#startSpinner(): void {
    this.#timer = setInterval(() => {
        for (const state of this.#pendingStates) {  // No allocation
            // ...
        }
    }, 250);  // Also throttled
}
```

### Profile Before Optimizing

Don't optimize without evidence. If you suspect performance issue:
1. Reproduce with large session (1000+ tool calls)
2. Profile with Node.js `--inspect`
3. Identify bottleneck
4. Optimize with benchmark showing improvement

---

## Documentation Standards

### Public API

**JSDoc required:**
```typescript
/**
 * Finalize this ledger, applying retention policy based on mode.
 *
 * @param mode - Display mode at run start
 * @param event - Terminal agent_end event (undefined for manual finalization)
 * @returns Finalized phase ("filtered" or "full")
 */
finalize(mode: CompactMode, event: AgentEndEvent | undefined): LedgerPhase {
    // ...
}
```

### README Updates

**When to update README:**
- New feature visible to users
- Changed behavior
- New configuration option
- Breaking change

**Where to update:**
- README.md (Russian default) and README.en.md (English translation)
- docs/FULL-DOCUMENTATION.md (complete reference)
- docs/CONFIGURATION.md (if config change)
- docs/ARCHITECTURE.md (if internal change)

---

## Release Process

**Versioning:** Semantic versioning (MAJOR.MINOR.PATCH)

- **MAJOR:** Breaking changes (e.g., incompatible config format)
- **MINOR:** New features (e.g., new display mode)
- **PATCH:** Bug fixes (e.g., memory leak fix)

**Release checklist:**
1. All tests pass
2. Type check clean
3. Lint clean
4. Manual smoke test on OMP 18.2.9
5. Update CHANGELOG.md
6. Tag release: `git tag v1.2.3`
7. Push: `git push origin v1.2.3`
8. Create GitHub release with notes

---

## Host Version Bump Checklist

The repository pins stock OMP through two independent numbers (see
`context/host-pin-versus-public-floor.md`):

- **Gate pin** — `devDependencies["@oh-my-pi/pi-coding-agent"]` in the root
  `package.json` plus `StockHostAdapter.hostVersion` in `.omp-plugin/host-adapter.ts`.
  It records the release on which the plugin's critical private surfaces were verified.
- **Public floor** — `engines.omp` in the root `package.json`. It records the release
  below which the plugin cannot recognise the host at all.

The two move independently: a fingerprint-preserving release raises the gate pin alone
and leaves the floor alone. Only a change inside `TRANSCRIPT_CRITICAL_METHODS` — or in
the tool/read-group shapes (`TOOL_METHODS` / `READ_GROUP_METHODS`) — is a reason to move
the floor.

**Diff checklist.** `node_modules` is not version-controlled, so snapshot the
outgoing tree **before** `bun install`, then compare. Snapshot all of
`@oh-my-pi/*`, not only the two primary packages: one `diff -rq` then answers
every question, and the plugin imports four of them. For
`pi-natives-darwin-arm64` (156 MB of prebuilt binaries) keep an md5 manifest
instead of the files.

```bash
B=runtime/omp-<old>/node_modules/@oh-my-pi
for p in $(ls node_modules/@oh-my-pi); do
  mkdir -p $B/$p && cp -R node_modules/@oh-my-pi/$p/src $B/$p/src 2>/dev/null
  cp node_modules/@oh-my-pi/$p/package.json $B/$p/
done                                    # ~48 MB, ~2700 files

diff -rq $B/pi-coding-agent/src node_modules/@oh-my-pi/pi-coding-agent/src
diff -rq $B/pi-tui/src node_modules/@oh-my-pi/pi-tui/src
```

Byte-identical trees settle the whole checklist at once, and that was true for
every move from 18.0.2 through 18.1.4. It is not the normal case: 18.1.10
changed 356 paths, 18.1.14 changed 54, 18.1.15 changed 46, 18.1.17 changed
77, 18.2.0 changed 237 agent paths plus 5 in `pi-tui`, 18.2.5 modularized UI components and theme into `pi-tui`, 18.2.6 is a point maintenance release
with byte-identical `pi-tui`, and 18.2.7/18.2.8 changed hundreds of agent paths while leaving every file this plugin patches byte-identical to 18.2.6 (the
only `pi-tui/src/tui.ts` delta is a Glyph Protocol repaint hook). 18.2.9 changed 245 paths package-wide while `pi-tui/src/chat/*` and `src/chrome/*` stayed
byte-identical to 18.2.8; judge by changed files, never by diff size — every one of those moves preserved the contracts
this plugin depends on. When the trees differ, walk the eleven items below by
file and probe anything the plugin calls. A changed `pi-tui` deserves one extra
look because the mid-turn history publication rests on it: confirm
`resetDisplay()` still clears saved scrollback (`\x1b[3J`), which is what makes
a published row retractable. Cursor/editor/mouse additions are harmless only
when that seam remains.

Then `diff -u` scoped per file. All paths are relative to
`node_modules/@oh-my-pi/pi-coding-agent/`:

1. `src/modes/components/transcript-container.ts` — any new method that renders blocks
   bypassing `render`, and any change to the methods the fold wraps (`render`,
   `renderTail`, `addChild`, `clear`, `peekFinalizedBatch`, `peekReplayBatch`,
   `peekFlushBatch`, `acknowledgeFinalizedBatch`).
2. `src/modes/controllers/event-controller.ts` — changed terminality conditions
   (`isTerminal`, background-task call ids, orphaned tool completions), any new path that
   completes a tool card.
3. `src/modes/controllers/input-controller.ts` + `src/session/agent-session.ts` — the
   await contract for plugin callbacks: shortcuts called without `await`, commands
   awaited inside `try/catch`.
4. `src/modes/components/tool-execution.ts` — the set of callbacks `component-binding.ts`
   observes (`updateArgs`, `updateResult`, `setArgsComplete`, `setExpanded`). The real
   filename is `tool-execution.ts`; some plan notes in `code-review/` call it
   `tool-execution-component.ts`.
5. `src/modes/components/read-tool-group.ts` and `src/modes/utils/ui-helpers.ts` — shape
   changes.
6. `src/config/keybindings.ts` and `src/config/settings-schema.ts` — the plugin reads both
   (display-cycle shortcut validation, host-settings bridge).
7. `src/extensibility/extensions/runner.ts` (the `#RESERVED_SHORTCUTS` copy in
   `.omp-plugin/display-cycle.ts`) and `src/session/shake-types.ts` (the
   `formatShakeSummary` anchor in `.omp-plugin/post-turn-shake.ts`) — the
   plugin carries copies of these host internals; confirm each new tree is
   byte-identical before the provenance comments move with the pin.
8. `@oh-my-pi/pi-tui/` (in `node_modules/` and `runtime/omp-<new>/node_modules/`) — the
   host tracks its version, and `TUI_OPTIONAL_METHODS` (`resetDisplay`) plus every
   width/truncation helper the plugin measures with (`visibleWidth`,
   `truncateToWidth`) live there. It also carries the Markdown renderer that emits
   OSC 8 hyperlinks into transcript rows; confirm neither the `TUI` class surface nor
   the width helpers change (empirical `visibleWidth`/`truncateToWidth` probe with an
   OSC 8-wrapped string is the 5-minute check).
9. `src/modes/components/tool-execution.ts` + the rebuild call sites — the two
   ordering contracts the binding layer now proves ownership with. A rebuilt
   card MUST still receive its real id through
   `updateResult(result, isPartial, toolCallId)` (claimed by
   `#bindObservedToolIds()`), and the host MUST still create one card per tool
   call in message order (the stream pre-allocation in
   `observeAssistantMessage` reserves state in that same order). If either
   moves, a collapsed history rebuild or a native-route sibling silently
   returns the whole visible history to framed chrome — the integration tests
   `"a manual shake rebuild binds the collapsed tail"` and `"an unruled tool
   streamed beside bash keeps the bash row compact"` are the canaries.
10. `src/modes/components/read-tool-group.ts` (`readArgsCollapseIntoGroup`,
   `readArgsHaveTarget`) + `src/internal-urls/router.ts` — the read shape rule the
   plugin mirrors in `host-surface.ts` (`FULL_CARD_READ_SCHEME`). Re-derive the
   scheme list from the handlers the host registers, and confirm stock still
   defers a read only until its args carry a target: the plugin evaluates the
   same rule on a different streaming snapshot, so a changed condition moves the
   group/full-card boundary. Both disagreement directions are repaired inside the
   binding layer (a claimed read is marked group presentation; an unobserved
   marked read is a second-chance order candidate), so the failure mode of drift
   is a framed card for one execution window rather than a crossed pairing —
   `"a read the host renders as a full card keeps its sibling compact"` and
   `"a read whose stream snapshot looked collapsible is not crossed with its
   sibling"` are the canaries, and `OMP_COMPACT_TRACE=1` names the branch.
11. `src/modes/components/transcript-container.ts` — the append-only publication
   contract (`transcriptBlockMode`, `getTranscriptStableRows`,
   `renderTranscriptStableRows`, `emittedStableRows`, `canRemoveBlock`). The
   fold's carrier publishes a long compact turn's settled rows into native
   scrollback through it, so confirm the container still captures a block's
   presentation mode inside `addChild` (the declaration must land before the
   child joins the transcript), still verifies a published prefix by rendered
   rows, and still reports emitted counts per block in transcript order. A
   changed capture point or a retracted contract means one long turn stops
   growing the terminal's history — `"a long compact run publishes its settled
   rows while the agent still works"` and `"a long compact run publishes its
   settled head and keeps the newest rows on screen"` are the canaries.

**Isolated verification.** Create `runtime/omp-<version>/` mirroring an existing copy
(`runtime/omp-17.3.1/`): `package.json` (candidate version), `.gitignore`,
`launcher.test.ts` — do not copy `test.md` or `.omp-compact-test/`. Point the `compact`
script at the repo's plugin entry (`-e ../../.omp-plugin/index.ts`, not the stale
`../../plugins/omp-compact/index.ts` the old copies carry), then:

Also update the copied `launcher.test.ts` path assertion to match the corrected
script path — every existing copy carries the stale
`../../plugins/omp-compact/index.ts` assertion against its own corrected `compact`
script, so a verbatim mirror ships a failing launcher test.

```bash
cd runtime/omp-<version> && bun install
cd ../.. && OMP_STOCK_BIN=./runtime/omp-<version>/node_modules/.bin/omp \
  bun test --timeout=120000 docs/tests
```

This executes the stock-host tests against the candidate host without moving the root
pin. The only expected failure is the hardcoded version assertion in
`docs/tests/host-adapter.test.ts` (`stockHostVersion()` pin); any other failure is a real
regression.

Run `docs/tests/host-patch-surface.test.ts` as the live arity/presence guard: it catches a
missing method or a changed `Function.prototype.length` on the patched surface. It cannot
catch changed semantics (e.g. the shortcut `await` contract) — that is what the diff
checklist above is for.

For every new host path that completes a transcript row, confirm it stamps `settledAt` —
see `context/settled-frame-clock.md` for the four current paths and why the drain of
historical pending rows intentionally does not stamp.

**Pin-move edit list** (when the decision is to raise the gate pin):

- Root `package.json` devDependency and `bun.lock` (via `bun install`).
- `StockHostAdapter.hostVersion` in `.omp-plugin/host-adapter.ts`.
- The version story comment block in `.omp-plugin/host-surface.ts`.
- The host version assertions in `docs/tests/host-adapter.test.ts` and
  `docs/tests/marketplace.test.ts`.
- `VERIFIED_HOST_VERSION` in `docs/tests/host-patch-surface.test.ts`.
- Prose pins in `docs/CONTRIBUTING.md`, `docs/ARCHITECTURE.md`,
  `docs/FULL-DOCUMENTATION.md`, `README.md`, `README.en.md`.
- The provenance comments in `.omp-plugin/display-cycle.ts` and
  `.omp-plugin/post-turn-shake.ts` (after the re-check above).

---

## Getting Help

- **Bug reports and questions:** [GitHub Issues](https://github.com/arksdev/omp-compact/issues)
- **Documentation:** [Full guide](FULL-DOCUMENTATION.md) and the rest of [`docs/`](./)

---

## Code of Conduct

**Be respectful.** This is a collaborative project. We welcome contributions from everyone, regardless of experience level.

**Assume good intent.** Code review feedback is about the code, not the person.

**Ask questions.** If something is unclear, ask. Documentation improvements welcome.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
