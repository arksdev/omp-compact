# OMP compact plugin decisions

## Two runtime modes instead of one

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The early design supported `cards` and `live`. **Reason for superseding:** the user narrowed the product to the live workflow and the code removed every cards branch. **Rejected now:** preserving cards as dormant compatibility surface.

## Override renderers, not built-in tools

**Status:** superseded 2026-08-09 · **Evidence:** confirmed

The first implementation replaced entries in exported `toolRenderers` to preserve native schemas, approvals, execution, and built-in bookkeeping. A real stock 17.2.12 TUI smoke showed the live application still rendered the original rich bash card: the published `dist/cli.js` host and the out-of-tree extension do not share the renderer registry module instance. **Reason for superseding:** direct component probes exercised one module graph and were false evidence for the compiled host boundary. **Rejected now:** registry mutation cannot affect the actual TUI, even though it works in source-level probes.

## Re-register supported built-ins across the compiled host boundary

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The implementation re-registered supported built-ins under their existing names, cloned definitions from OMP's legacy factories, rendered through extension hooks, and delegated execution with `ctx.invokeTool`. **Reason for superseding:** code review and executable probes showed that load-time legacy definitions are bound to isolated defaults and lose session approval rules, current schemas, concurrency, wire metadata, and legacy parameter translation. **Rejected now:** manual schema/metadata mirroring or retaining the re-registration path; both duplicate host contracts and fail closed only by accident.

## Test the latest OMP in isolation

**Status:** active · **Evidence:** confirmed

Pin the current published OMP (17.2.12) in an isolated temp project and run its local `omp` binary. **Reason:** validates stock behavior without modifying the patched global 17.2.5 install. **Rejected:** replacing the global install would destroy the client patch; running the repo directly lacks installed workspace dependencies.

## Hide grouped reads at the group boundary

**Status:** superseded 2026-08-09 · **Evidence:** confirmed

The source-level prototype probe hid `ReadToolGroupComponent`, but the real compiled 17.2.12 host uses a different module instance, exactly like the renderer registry. Re-registering `read` under the same name still routes through host read grouping before its extension renderer. **Reason for superseding:** the wrapper cannot reach the host group instance. **Rejected now:** an alias would avoid grouping but changes the model-facing tool contract and cannot use same-name `ctx.invokeTool` delegation.

## Keep native read groups as the live-mode exception

**Status:** superseded 2026-08-09 · **Evidence:** confirmed

The exception was technically accurate but violated the defining `live` contract: all successful non-write tool rows must disappear. **Reason for superseding:** if read rows remain, `live` is not meaningfully distinct from `cards` for read-heavy work. **Rejected now:** shipping the native read group as an accepted limitation.

## Route live reads through a non-grouped alias

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The temporary `read_live` alias was an implementation workaround for hiding successful reads in live mode. **Reason for superseding:** the requested contract keeps native OMP read grouping in both modes, and the alias changes the model-facing tool contract. **Rejected now:** routing live `read` to a second name; same-name `read` registration preserves native `ReadToolGroupComponent` behavior.

## Compute write stats from pre-write content

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The implementation captured file text at `tool_execution_start` and compared it with raw `args.content`. **Reason for superseding:** native write normalizes hashline content and paths, may resolve a different canonical target, and can partially mutate multiple targets; executable probes produced confidently wrong `exact` counts. **Rejected now:** duplicating native path/content normalization in the plugin or reading raw args as the post-image.

## Replace lazy renderer properties explicitly

**Status:** superseded 2026-08-09 · **Evidence:** confirmed

The proposed `Object.defineProperty` handling correctly covered lazy registry getters in source probes, but the entire registry strategy failed at the compiled extension boundary. **Reason for superseding:** getter-safe mutation of the wrong module instance still cannot affect the live TUI. **Rejected now:** no renderer-registry mutation is used.

## Persist mutation rows during the live log and retain them at turn commit

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The earlier design emitted a visible replacement custom message as soon as a mutation completed. **Reason for superseding:** the plugin-only adapter can render the mapped native component itself, while a `display:false` typed custom message preserves replay data without adding a second transcript block or risking duplicate chronological rows. **Rejected now:** display-true replacement rows as the primary live renderer; they require ordering/mapping coordination and can duplicate a native card.

## Persist typed audit data separately from the live native row

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

During a run, the mapped native tool component renders the compact mutation or Git line in its original chronological position. The first hidden-evidence implementation used a `display:false` custom message. **Reason for superseding:** stock `sendMessage()` calls `agent.steer()` whenever the session is streaming, even with `triggerTurn:false`, so persistence could alter native agent execution. **Rejected now:** any audit persistence path through `sendMessage`.

## Keep the visual test runtime until user acceptance

**Status:** active · **Evidence:** confirmed

Keep the stock OMP installation, plugin source, lockfile, and runnable mode commands in `runtime/omp-17.2.12/` until the user explicitly asks to remove them. **Reason:** manual visual validation is part of the deliverable; deleting a disposable-looking smoke directory before user acceptance destroys the exact environment and evidence they need to inspect. **Rejected:** automatic `rm -rf` cleanup immediately after agent-only smoke tests.

## Render completed actions as custom transcript messages

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The first live implementation used extension tool renderers that returned zero rows and emitted completed custom messages. **Reason for superseding:** obtaining those renderers required same-name tool re-registration, which broke native safety contracts. **Rejected now:** extension-renderer wrappers; custom messages remain, but native card suppression moves to per-instance runtime render wrappers.

## Resolve edit summaries per changed file

**Status:** active · **Evidence:** confirmed

Emit one live mutation entry for every `details.perFileResults` item, using that item's `path` and `diff`; use top-level `details.path` for single-file results and parse `[PATH#TAG]` section headers from `args.input` only as a fallback. **Reason:** the hashline `edit` contract carries the patch in `args.input`, not `args.path`, so treating it like `write` produced `edit: ?`; aggregate diffs also cannot reliably attribute statistics to multiple files. **Rejected:** persisting `?`, guessing from the first combined diff, or collapsing a multi-file edit into one row. A real stock 17.2.12 live run rendered `• edit: smoke-work/edit-path-smoke.ts +1|1` and changed the fixture.

## Fixed mutation statistics colors

**Status:** active · **Evidence:** confirmed

Keep `write` and `edit` labels neutral and color only the exact mutation counts: nonzero additions use fixed `#A4D734`, nonzero removals use fixed `#A1471A`, and zero values use the existing dim gray. **Reason:** the tool name should not inherit a theme's accent/success color; the numbers are the meaningful change signal and must remain recognizable across themes. **Rejected:** passing the whole row through `renderStatusLine`, which colors the title accent and all meta dim, and theme-relative `success`/`error`, which changes the requested colors with the active theme.

## Render transient rows in the normal tool-output area

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The prior implementation used extension `renderCall`/`renderResult` hooks. **Reason for superseding:** the plugin-only constraint forbids re-registering native tools, and stock OMP has no public built-in renderer override. **Rejected now:** extension renderer injection; a reversible wrapper on the live native `ToolExecutionComponent.render` keeps the row in the same transcript area without touching tool definitions.

## Keep native read grouping in cards and live

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The previous design re-registered `read` under its original name. **Reason for superseding:** any native-tool re-registration violates the plugin-only safety boundary. **Rejected now:** aliases and same-name wrappers. Stock `ReadToolGroupComponent` remains native and is only post-processed on the live instance; its settled rows are the documented live-mode exception.

## Animate mutation previews before persistence

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The implementation opted injected definitions into host spinner frames. **Reason for superseding:** injected definitions are removed with tool re-registration. **Rejected now:** renderer metadata injection. A session-start timer owned by the plugin requests TUI repaint only while mapped compact components are pending, and is cleared automatically on session shutdown.

## Persist typed mutation evidence for replay

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The first replay format used a `display:false` typed `custom_message` with empty LLM content. **Reason for superseding:** empty content does not prevent the streaming `sendMessage()` path from steering the agent. Legacy records remain readable and hydrate correctly, but new records use non-context custom entries.

## Persist audit evidence with `appendEntry`, never `sendMessage`

**Status:** active · **Evidence:** confirmed (stock 17.2.12 source and integration tests)

For every verified mutation or recognized Git record, call `appendEntry("omp-compact-write" | "omp-compact-git", details)` at tool completion. This creates a chronological `type:"custom"` session entry that never enters model context and never creates a transcript component. Resume hydrates these entries by `toolCallId`; it also accepts legacy `type:"custom_message"` evidence. Existing message renderers stay registered only so old display-visible sessions remain readable. **Reason:** stock `sendMessage()` steers during streaming regardless of `triggerTurn:false`; `deliverAs:"nextTurn"` would avoid immediate steering but delay the record and still pollute future model context. **Rejected:** both `sendMessage` variants for audit persistence.

## Neutralize grouped read by patching the TUI container base

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The implementation wrapped the live root's deepest `Container.render` prototype so it could see read groups across the compiled boundary. **Reason for superseding:** even a correctly discovered base prototype has process-wide scope and can affect unrelated sessions/components. **Rejected now:** any imported or global/base prototype patch. The runtime adapter detects each live read-group instance and installs a reversible own `render` wrapper only on that object.

## Hide the host todo card in live instead of re-registering `todo`

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The implementation hid todo through the same container-base patch. **Reason for superseding:** the global patch has a wider scope than the owning session. **Rejected now:** re-registering todo or patching a shared base. The runtime adapter maps the live todo `ToolExecutionComponent`, keeps its compact row during the working phase, and returns zero rows only at the filtered terminal commit; abort/error full commits preserve it.

## Keep the active turn log uncommitted, then fold it at terminal completion

**Status:** active · **Evidence:** confirmed

The host inserts separators and makes settled rows irreversible once they enter native scrollback. The plugin-only adapter therefore captures the live transcript at `session_start`, wraps only that instance, and holds tool/read/custom-log members from the current agent run in the live region with zero committed rows. During work, the carrier renders every tool entry chronologically. On terminal completion it re-renders the same members through the turn retention filter, commits only retained mutation/Git rows, and releases the final assistant answer; on abort/error without an answer it commits the full log unchanged. **Reason:** cleanup after the final answer is impossible once routine rows have been written to immutable scrollback. **Rejected:** per-tool zero rows, post-hoc terminal erasure, global/base prototype patches, and appending a detached summary after the answer.

## Animate pending tool rows with the Working dot frames, never the hourglass

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The earlier renderer-injection path could not obtain host spinner ticks, and timers armed at `tool_execution_start` did not fire reliably during execution. **Reason for superseding:** the new adapter is installed at `session_start`, before streaming begins, and owns a session-lifetime timer that only requests repaint while its pending-component set is non-empty. **Rejected now:** tool-start timers or injected renderer flags; the session timer must be validated through a real stock-TUI smoke before acceptance.

## Streamed agent answers must leave the fold once they gain text

**Status:** active · **Evidence:** confirmed (regression test, stock 17.2.12 host components)

The host mounts the assistant answer block empty and streams text into it. While empty it renders zero rows, so `planFoldRuns` absorbed it as a transparent seam into the neighboring tool run (a hidden fold member). When the model's text arrived the run re-planned without it — but the block's fold role was never cleared, so its shadowed `render` returned `EMPTY_LINES` forever: the answer existed in the session tree yet never appeared on screen. The fold now records every planned member and, after re-planning, releases any child that stopped being a member: the role is deleted and the own-method shadows are removed, so the block renders natively again (separated by the host's blank row). Reproduced red/green: the streamed-reply integration test fails without the release pass and passes with it. **Reason:** roles must be recomputed wholesale in both directions — the fold had been purely additive. **Rejected:** never absorbing zero-row blocks at all (dense tool traffic depends on transparent seams), or delaying release until session end.

## Drop cards mode and use deferred live-log compaction

**Status:** active · **Evidence:** confirmed

There is one product mode: while an agent run is unfinished, all mapped tools render as a compact chronological log; once the terminal assistant answer completes, the log is filtered in place to successful non-zero write/edit mutations plus Git records. **Reason:** this matches the established `omp-compact-tools.sh` interaction model and the user's intended distinction between ongoing work and a completed task. **Rejected:** cards mode, immediate per-tool disappearance, and a completed-turn aggregate that hides which files or Git operations mattered.

## Rewrite around first-class host presentation hooks

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The proposed rewrite added public renderer hooks to `oh-my-pi`. **Reason for superseding:** the user established a hard plugin-only boundary: `oh-my-pi/**` must remain unchanged. **Rejected now:** any host API, host patch, custom OMP build, or coding-agent changelog work.

## Source mutation audit summaries from native tool results

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The proposed rewrite changed native write/edit details to expose standardized mutation summaries. **Reason for superseding:** that requires modifying host tools. **Rejected now:** host result-contract changes. The plugin may consume existing `resolvedPath`, `diff`, and `perFileResults`, then validate bounded local snapshots against the actual post-state.

## Move compact transcript grouping into the host container contract

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The proposed rewrite changed `TranscriptContainer` separator semantics. **Reason for superseding:** host changes are outside the allowed scope. **Rejected now:** host grouping metadata. The proven fold remains an isolated, version-pinned, reversible adapter on the live transcript instance.

## Fail closed on hosts without presentation hooks

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The previous fail-closed design depended on a new host capability. **Reason for superseding:** no such capability may be added. **Rejected now:** version checks for hypothetical APIs. The plugin instead probes the live stock-TUI shape transactionally and leaves native rendering untouched when the shape is not recognized.

## Enforce a hard plugin-only boundary

**Status:** active · **Evidence:** confirmed

All implementation and test changes stay under `omp-patch/**`; `oh-my-pi/**` is read-only reference material. The plugin must not call `registerTool`, `ctx.invokeTool`, or legacy definition factories for native tools. **Reason:** native schemas, approval rules, session settings, concurrency, wire metadata, execution, progress, and cancellation remain correct only when the original stock `AgentTool` stays installed. **Rejected:** host modifications, custom OMP builds, schema mirroring, and same-name tool wrappers.

## Patch only live TUI instances through a per-session runtime adapter

**Status:** active · **Evidence:** confirmed

At `session_start`, capture the live TUI root, locate the actual transcript, wrap that instance's `addChild`, and install reversible own-property wrappers on recognized `ToolExecutionComponent` and `ReadToolGroupComponent` objects. Map components to `toolCallId` through `updateArgs`, `updateResult`, and `setArgsComplete`, backed by extension event state and branch-order replay data. **Reason:** live instances cross the compiled boundary while preserving native tool objects; per-instance descriptors limit scope and can be rolled back exactly. **Rejected:** imported/global prototype mutation or parsing rendered text to infer identity.

## Keep mutation audit plugin-side but verify the effective target

**Status:** active · **Evidence:** confirmed

For local write candidates, unwrap only public hashline/path selectors, cap the pre-image by bytes/lines, and at completion require native `details.resolvedPath` (including realpath comparison) to match before reading the actual post-image and running a bounded diff. Edit consumes native `diff`/`perFileResults` even on aggregate failure and emits successful mutations before errors. **Reason:** this fixes normalized content, wrapped path, empty write, format-on-save, partial edit, and marker-line bugs without changing host code. **Rejected:** exact statistics for URI, SQLite, archive, conflict/multi-target, path mismatch, or oversized inputs.

## Probe capabilities transactionally and fail open to native UI

**Status:** active · **Evidence:** confirmed

Validate the live transcript and component method shapes before committing any wrapper. If any capability is absent or an install step fails, restore every descriptor, stop plugin timers, and keep stock native rendering with one warning. **Reason:** a version-pinned private TUI adapter must never leave a half-patched session. **Rejected:** best-effort partial installation or an unsafe fallback to tool re-registration.


## Keep native read grouping only while the turn is active

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The adapter initially retained the native `ReadToolGroupComponent` presentation and only dimmed it. **Reason for superseding:** the required visual language has one lowercase compact row per read and must not expose the native `● Read` header, bold/accent styling, or hourglass. **Rejected now:** parsing or recoloring native presentation text.

## Render grouped reads from fully mapped tool state

**Status:** active · **Evidence:** confirmed (stock source, integration suite, live TUI smoke)

Keep the native `ReadToolGroupComponent` as the chronological transcript carrier, but render one shared compact row per mapped read `ToolState`: `• read <path>` when settled and an activity-frame `Working… read <path>` while pending. Compact the group only when every observed native entry ID maps to a tracked read state; mixed, unknown, ambiguous, expanded, and incompatible groups delegate the whole block to native rendering. Track host-before-extension creation order, `renameEntry(oldId,newId)` including empty provisional IDs, and replay mappings explicitly. **Reason:** this preserves native grouping, execution, and scrollback ownership while giving reads the same visual language as other tools without guessing from presentation text. **Rejected:** order-only binding, partial compaction of mixed groups, and global/prototype read patches.

## Use the neutral pending surface for routine rows

**Status:** superseded 2026-08-10 · **Evidence:** confirmed

The first visual-polish pass wrapped routine rows in `toolPendingBg` and padded the band to terminal width. **Reason for superseding:** manual review found the custom band visually intrusive; the requested correction is the terminal's ordinary transparent background for every compact row. **Rejected now:** any semantic or neutral background token, width padding, or ANSI background open/reset sequence.

## Keep every compact row on the transparent terminal background

**Status:** active · **Evidence:** user-confirmed

Render routine, Git, mutation, pending, settled, and error rows using foreground styling only. Fit overlong content to the component width, but never pad short rows and never emit ANSI background codes. Keep the `•`/`✗` markers, Working activity frames, and fixed mutation-count colors unchanged. **Reason:** compact rows should integrate with the surrounding transcript rather than form a separate custom surface. **Rejected:** `toolPendingBg`, `toolSuccessBg`, selected/accent surfaces, hard-coded RGB backgrounds, and background-reset padding.

## Match the stock Working activity spinner

**Status:** active · **Evidence:** confirmed (stock source, deterministic tests, live TUI smoke)

Pending compact rows use `theme.getSpinnerFrames("activity")`, the same symbol-theme source as stock OMP's Working loader, with `theme.spinnerFrames` only as a compatibility fallback for fixture themes. Adapter-owned deterministic ticks repaint only pending mapped states; the session-lifetime timer is reused across turns and cleared on rollback, switch, or shutdown. **Reason:** the activity preset provides the requested braille-dot sequence and avoids a second independent indicator or wall-clock drift. **Rejected:** emoji/hourglass, status-spinner frames, hard-coded frame arrays, and per-tool timers.

## Finalize the log at terminal `agent_end`, not at individual message/tool events

**Status:** active · **Evidence:** confirmed

Open one `TurnLedger` at `agent_start` and keep it across all tool-use model loops. Assistant messages with `stopReason: "toolUse"` and `agent_end.willContinue === true` do not compact anything. At terminal `agent_end`, inspect the final assistant message: a visible non-tool answer commits the filtered log; abort/error without such an answer commits the full live log unchanged. `message_end` only records the answer candidate because message events may race with agent end and intermediate assistant text is not proof of task completion. **Reason:** the semantic boundary is completion of the whole agent run, not one provider response.

## Retain only successful non-zero mutations and Git records after an answer

**Status:** superseded 2026-08-11 · **Evidence:** confirmed

The completed-turn retention predicate keeps each successful write/edit entry only when verified `added > 0 || removed > 0`. It removes reads, searches, ordinary shell/tools, no-op mutations, and non-Git errors/status rows. Recognized Git command records are the explicit exception and remain in chronological order, including failed Git operations marked as failed. **Reason:** completed history should explain durable file/repository changes, while the assistant answer explains the rest. **Rejected:** keeping all errors, generic test summaries, counts-only turn summaries, or aggregating multiple file mutations into one opaque line.

## Format Git activity as typed one-line records

**Status:** superseded 2026-08-11 · **Evidence:** confirmed

Detect direct Git invocations conservatively from Bash command segments without executing additional commands. Emit a typed `omp-compact-git` row at completion and retain it at turn commit. Commit rows prefer `git commit <short-hash> <subject>` using the command/result evidence already available; other Git operations use `git <subcommand> <sanitized one-line args/result>`, and failures carry an explicit failure marker. Ambiguous shell text is treated as an ordinary Bash row and discarded after a successful answer. **Reason:** repository transitions are durable user-facing events, but false Git classification or hidden extra Git probes would make the audit misleading.

## Synchronize asynchronous audit events before terminal folding

**Status:** active · **Evidence:** confirmed (stock 17.2.12 source and live reproduction)

Stock agent event listeners are invoked without awaiting returned Promises, so `tool_execution_start`, `tool_execution_end`, and `agent_end` bookkeeping can overlap. The compact plugin must register each write-audit lifecycle record synchronously, make completion await the same record, and drain all in-flight audit work before terminal ledger folding. **Reason:** otherwise a fast new-file write can finish before its async pre-image/canonicalization candidate is registered, or terminal cleanup can snapshot the ledger before post-image evidence is attached. **Rejected:** relying on handler invocation order or adding timing sleeps; those only make the race less visible and do not preserve native execution semantics.

## Aggregate successful commit hashes after retained mutations

**Status:** active · **Evidence:** user-confirmed; deterministic tests and stock TUI smoke

Working and abort/full phases keep every conservatively recognized Git row and the complete typed `appendEntry` evidence. A successful terminal answer removes the individual Git rows and appends one summary after all retained write/edit rows: `git commit: hash1, hash2, …`. Only successful commit records whose result proves a created hash contribute; status/add/push/switch/rebase, failed commits, and hashless commits do not. Hash order is chronological, and the newest hash uses the same fixed `#A4D734` foreground as non-zero additions. **Reason:** long tool runs can contain many routine Git commands, while the durable completed-history signal is the set of commits actually created. **Rejected:** retaining every Git invocation after collapse, retaining one row per commit, or mutating persisted evidence to manufacture the summary.

## Resolve host settings only through the initialized main session

**Status:** active · **Evidence:** confirmed (stock 17.2.12 source, unit contract, isolated TUI save/reopen smoke)

Read and write `recap.enabled` and `hideThinkingBlock` only through `AgentRegistry.global().get(MAIN_AGENT_ID)?.session.settings`, and accept both object- and constructor-shaped `AgentRegistry` exports. Require `session.sessionManager === commandContext.sessionManager` before exposing host rows. **Reason:** the exported global settings proxy throws `Settings not initialized. Call Settings.init() first.` in extension context, while the active main session already owns the correctly initialized Settings instance. **Rejected:** importing the global proxy, calling `Settings.init()` from the plugin, or using an unmatched/global session.

## Leave pending audit records alive across continuation boundaries

**Status:** active · **Evidence:** confirmed (real-session replay canary and lifecycle regression)

At `agent_end(willContinue)` wait only for completions already consumed by the audit lifecycle; do not wait for or abandon records whose `tool_execution_end` has not arrived. Keep those records mapped so the late end can publish mutation/Git evidence. At a terminal boundary, purge unended records and abandon timed-out completions. **Reason:** stock invokes listener chains without awaiting one another, and a real `git status` end arrived after continuation `agent_end`; abandoning it made durable evidence disappear. **Rejected:** increasing the timeout, blessing the missing row in a golden, or allowing evidence to resurrect after terminal transcript commit.

## Replay normalized real histories, never raw transcripts

**Status:** active · **Evidence:** confirmed (10 source histories, privacy/cap checks, golden and inventory suites)

Build replay fixtures from structurally unique events extracted from real session JSONL histories, recursively redact identifying/secrets-bearing text and cap every nested field plus the corpus. Golden tests compare the complete observable carrier/transcript projection and terminal ordering. Inventory requires every encountered shape to be compact-handled or classified with one explicit fallback reason: `interactive`, `unmapped`, `expanded`, or `incompatible`. **Reason:** synthetic happy paths missed real ordering, nesting and fallback shapes, while raw transcripts would disclose unnecessary private data and grow without bound. **Rejected:** fabricated events to reach a target corpus count, raw transcript copies, implementation-detail snapshots, and silent unknown native fallback.

## Freeze user settings for one logical run

**Status:** active · **Evidence:** confirmed (configuration, mode-policy, stats and auto-shake tests)

Load persisted/plugin env settings at safe boundaries and use an immutable snapshot through every continuation segment of the same logical run. `OMP_COMPACT_PLUGIN=0` and legacy mode `off` remain hard runtime gates; explicit mode env overrides persisted mode. **Reason:** mid-run mode/stats/shake changes otherwise mix projection and maintenance semantics inside one transcript, and a disabled run could inherit a stale armed shake. **Rejected:** reading mutable config independently in each event handler or re-arming maintenance across continuation/session boundaries.

## Centralize structured presentation matching in one typed registry

**Status:** active · **Evidence:** confirmed (unit, stock-component integration, real-history replay inventory and goldens)

Keep canonical tool names/aliases, presentation route, audit selector, bounded description/result metadata and known argument/detail shapes in `tool-presentation-rules.ts`. Runtime interception, ledger phases, mutation diffing, Git parsing, transcript folding and settings remain separate mechanisms that consume only the registry classification. Resolve unknown tools to no rule and immediately preserve their stock renderer in working, filtered, full and clear phases. **Reason:** route knowledge had drifted across `compact.ts`, `render.ts`, `runtime-adapter.ts`, `index.ts` and a test-only inventory; a typed registry removes that duplication without becoming a general rules engine. **Rejected:** regex/ANSI matching against rendered native text, generic-compacting unknown tools, or moving execution/audit lifecycle into the registry. Replay inventory may import production rules for shape coverage, but full observable goldens and focused native-surface contracts remain independent so the registry cannot validate itself.

## Reapply presentation after in-session transcript reconstruction

**Status:** active · **Evidence:** confirmed (stock `/tree` and `/shake` rebuild paths plus live user verification)

Treat opening or rebuilding any current session transcript—including resumed sessions, successful session-tree navigation, and `/shake`—as an in-session presentation rehydration boundary. Reapply the active plugin settings to every compatible historical tool block in the reconstructed transcript, while preserving native fallback for interactive, expanded, unmapped, or incompatible blocks. **Reason:** stock reconstruction replaces transcript component instances; keeping bindings to disposed instances leaves the historical prefix native even though subsequent live tools compact correctly. The working session must remain uninterrupted and must not require client restart or session reopen. **Rejected:** restarting OMP, asking the user to reopen the session, wrapping only future messages, and provider- or command-specific presentation patches.

## Use the persistent compact launcher for session-log capture

**Status:** active · **Evidence:** confirmed (launcher contract test and runtime package script)

Use `bun run compact` when a session must remain persistent and its logs must be inspectable after the run. The launcher loads the plugin, unsets external mode/plugin hard overrides, leaves the persisted mode authoritative, and intentionally omits `--no-session`. **Reason:** forcing `live` and disabling session persistence prevents reliable reproduction and makes logs unavailable for analysis. **Rejected:** using the old mode-pinned non-persistent launcher for investigation; `stock`/`off` remain isolated native smoke commands.

## Report successful auto-shake with the stock summary format

**Status:** active · **Evidence:** confirmed (stock `formatShakeSummary` and user-observed manual output)

After a native auto-shake resolves successfully, show an ephemeral TUI confirmation using the same semantics and wording as manual `/shake`, for example `Shook 35 tool results (~11593 tokens freed).`; derive the count and `tokensFreed` from the actual `ShakeResult`, preserve stock pluralization and ` + ` joining for mixed regions, and show `Nothing to shake.` for a successful no-op. Gate skips, abort/dispose, persistence failures and shake errors must not emit success. **Reason:** silent maintenance gives no operator evidence that context was actually reduced. **Rejected:** silent success, estimated token counts, duplicate confirmation per run, and persisted custom/session entries that would alter tree topology.

## Diagnose multi-response last-group filtering at native scrollback

**Status:** active · **Evidence:** confirmed (real session JSONL, stock TUI source, normalized replay fixture and full integration contracts)

The real session `2026-08-11T17-41-06-417Z_019ff1e9-e8f1-7000-b495-bbb509746832.jsonl` contains one completed logical run with 15 assistant `stopReason=toolUse` responses followed by terminal `stop`; its persisted `omp-compact-run-1` carrier records `actions=31` and `messages=16`. Therefore provider responses do not define ledger/stat boundaries. Stock TUI commits mutable live-region rows into frozen native scrollback when they move above the viewport unless pinned. Text-separated verbose groups can freeze early compact rows, so terminal projection repaints only later mutable rows; this matches the observed “last group” symptom. **Reason:** the fix must replay structured presentation after terminal projection through capability-checked exact-root `resetDisplay()` when committed mutable rows exist. **Rejected:** provider/model-name branches, resetting the ledger on intermediate responses, global scrollback settings, ANSI parsing, restart/reopen, and terminal automation.

## Place terminal scrollback replay after stats

**Status:** active · **Evidence:** confirmed (D03 tests and stock/manual session behavior)

Terminal replay is a separate post-projection action: persist/insert the optional stats carrier first, then call the exact-root capability-checked `resetDisplay()` only when the fold reports committed mutable rows. Stats-disabled, no-usage, compact/full, abort/error, continuation, missing-capability, pending-generation, disposed and thrown-stats paths fail open without a false success. **Reason:** replaying before stats would leave the newly inserted carrier in frozen native scrollback, while unconditional reset would churn ordinary runs. **Rejected:** resetting at every `agent_end`, using rendered text to infer commitment, or coupling replay to provider/model names.

## Merge concurrent settings writes by bounded leaf patches

**Status:** active · **Evidence:** confirmed (config concurrency contracts, atomic-write failure tests)

Each settings store derives only the leaf fields changed from its loaded persisted snapshot, rereads the bounded JSON immediately before writing, and applies that patch to the latest normalized settings. An in-process per-path queue closes the reread-to-rename race for simultaneous writers; different fields compose and a same-field conflict resolves by queue/atomic-rename order (last successful writer wins). **Reason:** stale full-snapshot writes silently discard unrelated settings, while lock files or fsync would add unnecessary cross-process machinery to a local extension config. **Rejected:** persisting effective env overrides, whole-snapshot last-writer-wins, lock files, and unbounded retry loops.

## Prefer deterministic budgets over timing probes for evidence

**Status:** active · **Evidence:** confirmed (bounded hydration/diff contracts and adversarial tests)

Persisted replay payloads and exact edit diffs are rejected before allocation or native diff work when their byte, depth, line, file, or record budget is exceeded; the UI keeps native/fail-open presentation and never claims exact counts from a truncated candidate. The write path uses a static trimmed-middle line budget rather than wall-clock cutoffs. **Reason:** event-loop timing thresholds are machine-dependent and would make terminal behavior flaky, while deterministic structural limits bound hostile work and make false exact mutation evidence impossible. **Rejected:** unbounded native diffing, approximate counts after truncation, and latency tests based on elapsed milliseconds.

## Retire raw payloads only after filtered terminal projection

**Status:** active · **Evidence:** confirmed (C10 unit/integration contracts, 5,000-call rebuild stress, persistent TUI smoke)

After a successful `filtered` terminal projection, each completed tool state may discard raw args, result and per-call Git payload only after `RuntimeSessionState.terminalProjection()` has materialized its immutable mutation/Git summary. The state keeps minimal mutation evidence and the cached terminal projection; `compact` mode and abort/full diagnostics keep raw data. **Reason:** routine filtered rows no longer need tool payloads, while holding them across a long-lived transcript makes retained state proportional to every discarded output. The projection must be cached before release so a later render, terminal replay or narrow viewport cannot lose the mutation row or aggregate commit summary. **Rejected:** clearing payloads at `tool_execution_end`, clearing all modes, mutating persisted evidence, or using GC/timing probes as a correctness condition.

## Preserve live state against stale branch reconstruction data

**Status:** active · **Evidence:** confirmed (independent review scenario and active-rebuild contract)

During a rebuild, a branch can contain a historical tool-call snapshot for an ID that is still owned by the active working ledger. `stateForLedger` must preserve the active state’s streamed args as well as its result/partial status; branch data may refresh only a state belonging to the same replay/live ledger. **Reason:** the live event stream is authoritative while a tool is in flight, and overwriting its args can make an existing component render stale data until another update. **Rejected:** copying branch args into every matching ID, cloning active state for replay, or globally skipping exact-ID absorption.

## Scope unbound component fallback to one logical run

**Status:** active · **Evidence:** confirmed (independent review scenario and binding regression contract)

An unbound tool component observed before its matching live state is only eligible for the current logical run’s narrow order fallback. A fresh run discards any leftover component queue before creating its ledger. **Reason:** carrying an unproven component across a terminal boundary can bind it to an unrelated next-run state and turn an otherwise native fallback into an ambiguous rollback. **Rejected:** cross-run positional binding, retaining the queue indefinitely, or weakening exact-ID ambiguity handling.

## Tie deferred auto-shake to its logical-run epoch

**Status:** active · **Evidence:** confirmed (independent review scenario and async persistence regression contract)

Each `beginRun` advances a logical-run epoch captured by `onAgentEnd` before waiting for persistence. A deferred terminal callback must no-op if another run begins first. **Reason:** a session-level disposal generation cannot distinguish run A’s delayed persistence from a new run B in the same session; allowing it to dispatch could shake B’s context and consume B’s once-per-run budget. **Rejected:** relying only on `#shakenThisRun`, evaluating threshold after the wait, or cancelling all session work on every run boundary.

## Bind replayed read groups by their observed IDs before ordinal fallback

**Status:** active · **Evidence:** confirmed (current-session reproduction `019ff302-3030-7000-9878-f30918d0c435` and post-shake integration contract)

During stock transcript reconstruction (`/shake` and successful `/tree`), a `ReadToolGroupComponent` can receive `updateArgs` before branch hydration creates its `read` states. Its recorded exact IDs are stronger evidence than the historical ordinal ledger queue, which can contain the same ledger more than once when read calls are interleaved with other tools. Hydration therefore first binds a group only when every observed ID resolves to an unclaimed `read` state on one ledger; ordinal fallback remains available only for groups with no observed IDs. **Reason:** one native group with all real read IDs must hide in terminal `live`, while an incomplete/unknown group must remain native rather than silently dropping an entry. **Rejected:** deduplicating ledger order globally, binding a partial group, ignoring observed IDs after hydration, or hiding all read groups indiscriminately.

## Persist terminal stats before asynchronous projection drains

**Status:** active · **Evidence:** confirmed (session-tree carrier topology and fire-and-forget terminal regression contract)

On a successful terminal `agent_end`, stats evidence and its rendered line are frozen and persisted synchronously before the audit lifecycle schedules its asynchronous projection drain. At the same boundary, the adapter claims the exact working ledger; the claim preserves that ledger across a later `agent_start` and is released only after the drain has finalized its mutations/Git, placed the frozen stats line, and retired filtered payloads. The visual stats row still inserts only after mutations/Git finalize. **Reason:** a hidden custom carrier appended after the next user event becomes a sibling rather than an ancestor, so `getBranch()` cannot hydrate it after `/tree`; a late `RunStats.finalize()` can also observe a reset next run; and finalizing whichever ledger is active after the drain can incorrectly finalize run B rather than run A. **Rejected:** scanning sibling history through private session internals, relying on in-memory rows across reconstruction, delaying persistence until audit completion, moving visual stats ahead of mutation/Git finalization, or treating the currently active ledger as the delayed terminal target.

## Model each terminal statistics test as a real logical run

**Status:** active · **Evidence:** confirmed (RunStats lifecycle and focused full-suite regression)

An `agent_start` is required between independent terminal statistics samples. **Reason:** `RunStats` correctly locks the first terminal result and ignores later `message_end` events until a new logical run begins; a fixture that emits two terminal answers without that boundary only persists the first frozen result twice and does not test usage identity deduplication. **Rejected:** weakening the lifecycle to reopen a finalized run on an arbitrary message, or preserving a malformed fixture merely because it asserted the former duplicate-persistence side effect.

## Keep stats carrier insertion behind a fail-open host seam

**Status:** active · **Evidence:** confirmed (private OMP transcript child ordering and immutable-array regression contract)

Stats rows require insertion before an existing native answer, but raw `children.splice(...)` is a version-pinned host operation. **Decision:** route the mutation through one named, capability-checked HostAdapter helper that validates the exact transcript surface, index and current mutable children array, returning `false` without throwing on any incompatible surface. Runtime state treats that result as no visual stats row while retained/persisted evidence and native rendering continue normally. **Rejected:** direct array mutation from runtime state, append-only `addChild()` (wrong terminal ordering), global prototype patches, or a guessed fallback insertion position.

## Reject bounded JSON structural underflow immediately

**Status:** active · **Evidence:** confirmed (config load regression contract)

The bounded JSON scanner rejects a closing `}` or `]` that drives structural depth below zero before calling `JSON.parse`. **Reason:** malformed input must fail at the bounded structural boundary rather than continuing to scan an invalid shape; this keeps the scanner's depth invariant explicit and fail-closed. **Rejected:** relying on the later parser failure alone, which produces the same defaults but leaves the scanner's own structural accounting invalid.

## Default auto-shake threshold to 120k tokens

**Status:** active · **Evidence:** confirmed (configuration regression and stock shake/context-maintenance contracts)

Keep auto-shake opt-in, but use `120000` tokens as the persisted default threshold once enabled. A threshold of `0` continues to mean every eligible logical run. **Reason:** the former 2,000,000-token default was above the useful operating range for ordinary sessions and made an enabled feature appear inert; 120k provides meaningful headroom while the terminal-answer, known-usage, main-session, and once-per-run gates still prevent premature shaking. **Rejected:** enabling auto-shake by default, treating it as OMP compaction, or adding a fallback strategy after the context limit is already exceeded.