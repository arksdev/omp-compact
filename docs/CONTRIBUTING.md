# Contributing

Thank you for considering contributing to omp-compact! This guide covers development setup, code conventions, testing, and the contribution workflow.

---

## Development Setup

### Prerequisites

- **Bun 1.3+**
- macOS, Linux, or Windows capable of installing the pinned OMP package

The repository pins OMP 17.2.12, TypeScript, Bun types, and Biome in `package.json`/`bun.lock`.

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
OMP_STOCK_BIN=./node_modules/.bin/omp bun test component-binding.test.ts
```

The latest standalone release gate was 768 tests, 0 failures, and 3,375 assertions across 27 files. Treat the current command output as authoritative after further changes.

### Testing Locally

Install plugin for manual testing:

```bash
# One-time use
omp --extension /absolute/path/to/omp-compact/index.ts

# User-wide
mkdir -p ~/.omp/agent/extensions
ln -s /absolute/path/to/omp-compact ~/.omp/agent/extensions/

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

**One responsibility per module:**
- `runtime-adapter.ts` — host orchestration only
- `runtime-session-state.ts` — state management only
- `render-decision.ts` — decision tables only
- `render.ts` — row construction only

**Avoid circular dependencies.** Import tree flows downward:
```
index.ts
  → runtime-adapter.ts
      → runtime-session-state.ts
          → turn-ledger.ts
          → component-binding.ts
      → render-decision.ts
      → render.ts
          → tool-presentation-rules.ts
          → display-path.ts
```

---

## Testing Guidelines

### Test Structure

**File naming:** `<module>.test.ts`

**Test style:** Descriptive, grouped by feature.

**Example:**
```typescript
import { describe, expect, test } from "bun:test";
import { classifyAgentEnd } from "./turn-ledger";

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

**Not required (yet):**
- Integration tests (full lifecycle)
- Runtime adapter with real TUI components
- Concurrent rebuild scenarios

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
1. Automated checks run (tests, typecheck, lint)
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
export const TOOL_REGISTRY: Record<string, ToolPresentationRule> = {
    // ...existing tools

    my_new_tool: {
        route: "compact",              // or "read-group" or "native-live"
        audit: "write",                // or "edit" or "git-bash" or "none"
        knownArgs: ["path", "content"],
        knownDetails: ["resolvedPath", "size"],
        describe(args: unknown): ToolDescription {
            const path = stringValue(args, "path");
            return {
                label: "my_new_tool",
                details: path ? [path] : []
            };
        },
        resultMeta(result: unknown): readonly string[] {
            const size = numberValue(result, "size");
            return size ? [`${size} bytes`] : [];
        }
    },
};
```

2. Add tests in `tool-presentation-rules.test.ts`:

```typescript
describe("my_new_tool", () => {
    test("describes with path", () => {
        const desc = TOOL_REGISTRY.my_new_tool.describe({ path: "file.txt" });
        expect(desc.label).toBe("my_new_tool");
        expect(desc.details).toEqual(["file.txt"]);
    });

    test("describes without path", () => {
        const desc = TOOL_REGISTRY.my_new_tool.describe({});
        expect(desc.details).toEqual([]);
    });
});
```

3. No other changes needed. Decision tables use registry lookup.

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
- Main README.md (high-level)
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
4. Manual smoke test on OMP 17.2.12
5. Update CHANGELOG.md
6. Tag release: `git tag v1.2.3`
7. Push: `git push origin v1.2.3`
8. Create GitHub release with notes

---

## Getting Help

- 💬 **Questions:** [GitHub Discussions](https://github.com/arksdev/omp-compact/discussions)
- 🐛 **Bug reports:** [GitHub Issues](https://github.com/arksdev/omp-compact/issues)
- 📖 **Documentation:** [docs/](docs/)

---

## Code of Conduct

**Be respectful.** This is a collaborative project. We welcome contributions from everyone, regardless of experience level.

**Assume good intent.** Code review feedback is about the code, not the person.

**Ask questions.** If something is unclear, ask. Documentation improvements welcome.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
