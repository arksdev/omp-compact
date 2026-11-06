# Contributing

Thank you for considering contributing to omp-compact! This guide covers development setup, code conventions, testing, and the contribution workflow.

---

## Development Setup

### Prerequisites

- **Bun 1.3+**
- macOS, Linux, or Windows capable of installing the pinned OMP package

The plugin needs OMP 18.17 or later (`engines.omp`); the repository pins the omp it tests against in `devDependencies`. TypeScript, Bun types, and Biome are pinned in `package.json`/`bun.lock`.

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
OMP_STOCK_BIN=./node_modules/.bin/omp bun test docs/tests/integration-runs.test.ts
```

Treat the current command output as authoritative: the gate must come back with zero failures.

CI runs the same gate on every push and pull request (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`, then `bun run check`. The frozen lockfile is the part a local run cannot reproduce: a warm `node_modules` hides a drift between `bun.lock` and `package.json`. The `test` script sets `OMP_STOCK_BIN=./node_modules/.bin/omp` so the integration and replay suites run against the pinned omp; `host-env-guard.test.ts` fails the run when that variable is missing, because bare `bun test …` without it reports every stock-host test as skipped and still exits zero.

Config JSON persistence uses an in-process writer queue and atomic rename only — concurrent updates from separate OS processes on the same path are last-writer-wins (no lock file). See [CONFIGURATION.md](CONFIGURATION.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

### Testing Locally

Install or link the checkout for manual testing:

```bash
# One-time isolated source launch
omp --extension /absolute/path/to/omp-compact/.omp-plugin/index.ts

# Persistent user installation from the package root
omp plugin link /absolute/path/to/omp-compact --scope user

# Restart OMP, turn on /settings → Tools → Extensions → Extension Transcript Presenters,
# then verify with /compact-settings
```

---

## Code Conventions

### TypeScript Style

**Strict mode:** Enabled. No `any` in production code.

**Naming:**
- Private fields: `#camelCase`
- Public fields: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`

**Example:**
```typescript
export class SessionLedger {
    readonly #options: SessionLedgerOptions;
    #active: RunRecord | undefined;

    get active(): RunRecord | undefined {
        return this.#active;
    }
}
```

### Mutability

**Default to immutable:**
- Use `readonly` on class fields unless mutation required
- Use `readonly` on array/object types
- Return `readonly` arrays from public methods

### Error Handling

**Fail open to omp's own drawing.** When the presenter cannot read a block or does not know its shape, it answers `undefined` and omp draws its normal card. A presenter that throws makes omp draw the block in full and report the failure once, so a throw is a bug, not a fallback.

**Never throw from an event handler into omp.** Catch, warn once through the session UI, and keep going: a failed audit loses its evidence, not the run.

### Comments

**Explain "why", not "what":**
```typescript
// GOOD
// omp calls tool_execution_start listeners without awaiting them, so the
// pre-image read must finish before the tool's own write lands.

// BAD
// Reads the file
const before = readFileSync(path, "utf8");
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
- `.omp-plugin/index.ts` — event wiring, command and shortcut registration only
- `.omp-plugin/presenter.ts` — the transcript presenter's answers only
- `.omp-plugin/session-ledger.ts` — runs, calls and evidence by `toolCallId`, plus the branch walk
- `.omp-plugin/leaf-views.ts` — compact views of non-tool blocks from their data
- `.omp-plugin/native-text.ts` — ANSI rows to omp's `TspText`
- `.omp-plugin/render-decision.ts` — decision tables only
- `.omp-plugin/render.ts` — row construction only
- `.omp-plugin/tool-presentation-rules.ts` — rules registry (routes, aliases, shapes, lookups) only
- `.omp-plugin/tool-rule-describers.ts` — rule description behavior (describe/resultMeta, devices, hub mirror) only
- `.omp-plugin/vibe-cards.ts` — re-export entry point only (decode/render split)
- `.omp-plugin/vibe-cards-decode.ts` — defensive decoding of untrusted vibe payloads only
- `.omp-plugin/vibe-cards-render.ts` — worker-session row rendering only
- `.omp-plugin/vibe-cards-slots.ts` — slot formatters only
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
  → presenter.ts
      → session-ledger.ts
          → turn-ledger.ts
          → messages.ts
      → leaf-views.ts
      → render-decision.ts
      → render.ts
          → tool-presentation-rules.ts
              → tool-rule-describers.ts
          → display-path.ts
          → vibe-cards-render.ts
              → vibe-cards-slots.ts
          → vibe-cards-decode.ts
      → native-text.ts
  → audit-lifecycle.ts / audit.ts / git-records.ts
  → run-stats.ts / idle-queue.ts
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

**Also required:**
- Integration tests that boot the real plugin factory and register its presenter through omp's public `setTranscriptPresenters`, then draw real `ToolExecutionComponent` blocks in a real `TranscriptContainer`. The `integration-*.test.ts` suites share `integration-kit.ts` and cover runs and modes, evidence after the answer, history walks, and the stats row; `presenter.test.ts` and the replay goldens (`replay.test.ts`) use the same seam.
- Tests assert what the user sees (rows, persisted entries, sent messages), not wiring or source text.

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

4. No other changes are needed for an ordinary compact row: decision tables use registry lookup. A tool that needs its own row grammar rather than a `title: description` summary also gets a branch in `render.ts` ahead of the generic rule lookup, the way the `vibe_*` worker-session tools resolve through `vibe-cards.ts`. Without any rule a tool still gets omp's own one-row summary.

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
if (route === undefined) return "host-compact";       // omp's own row
if (route === "native-live") return "native";
if (mode === "clear" && isAnchor && terminalHashes > 0) return "summary";
if (mode === "clear") return "empty"; // full abort/error stays quiet too
if (phase === "filtered" && !hasMutations && terminalHashes === 0) return "empty";
// ... fallback rules
```

Expansion is not in the table: omp draws an expanded block in full whatever the presenter answers.

---

## Performance Considerations

### Avoid Unbounded Growth

Evidence per call, records per Git call and every persisted payload are bounded (see `messages.ts`). New per-call state needs a bound and a test for it.

### Keep the presenter cheap

omp calls the presenter while it draws the transcript, once per block and again on every data change. The presenter answers from the block and the ledger: no I/O beyond the one branch walk and no awaits.

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
- README.md (English default) and README.ru.md (Russian translation)
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
1. `bun run check` passes
2. Manual smoke on the pinned omp (`devDependencies["@oh-my-pi/pi-coding-agent"]`) with `Extension Transcript Presenters` on
3. Update CHANGELOG.md
4. Tag release: `git tag v1.2.3`
5. Push: `git push origin v1.2.3`
6. Create GitHub release with notes

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
