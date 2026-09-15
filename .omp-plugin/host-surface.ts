/**
 * B02: pinned stock host surface sheet.
 *
 * The verified half of the pinned-host adapter: every method-name
 * manifest, component fingerprint and argument-position decoder the
 * plugin knows about stock OMP components. Everything here is pure
 * shape knowledge — no instances, no patching, no side effects; the
 * live probes and wrapper transactions live in host-adapter.ts.
 *
 * ## Version story (do not "fix" the apparent skew)
 *
 * `StockHostAdapter.hostVersion` (`"18.2.0"`) is the **verified contract**
 * this module was written and tested against for the critical private
 * surfaces (tool/read-group/transcript/TUI method names and argument
 * positions). Comments that cite 17.3.1/17.3.4 mark leaf fingerprints
 * whose shapes were confirmed on those hosts (todo reminder, skill,
 * late diagnostics, user bash/eval). Neither string is a runtime gate:
 * every decision is a capability probe on the live instance.
 *
 * `package.json` `engines.omp` sets the public floor to `>=18.0.1`,
 * the release that rewrote the transcript container; support for older
 * hosts is discontinued. That rewrite turned the native-scrollback live
 * region into block lifecycle states (`active`/`settled`/`committed`)
 * plus acknowledged history batches, so `renderViewportTail`,
 * `isBlockUncommitted` and `isBlockInLiveRegion` no longer exist and the
 * per-block row accounting (`getTranscriptBlockVersion`,
 * `getTranscriptBlockSettledRows`, `setNativeScrollbackCommittedRows`)
 * has no consumer left. A plugin build for 18.0.0 finds no transcript
 * host from 18.0.1 on and stays fully native, which is why the floor
 * moved with that rewrite. 18.0.2 and 18.0.3 left every critical
 * fingerprint intact: the container only exported its own
 * `trimBlankEdges`, and the inline tool card gained styling plus a
 * trimmed-height check under a squeezed allocation. 18.0.4, 18.0.5 and
 * 18.0.6 left every critical fingerprint intact too: the changes are
 * purely additive — `ToolExecutionComponent` gained a `dispose()`
 * method, and the transcript gained an append-only surface
 * (`TranscriptBlockMode`, `TranscriptStableRow`,
 * `AppendOnlyTranscriptBlock`, `isRowPrefix`). 18.0.7 and 18.0.8 left
 * the container and the tool card byte-identical; their transcript-side
 * work is the stock usage row's own prompt→yield delta
 * (`display.showTurnTime`, `turnElapsedMs`), a surface this plugin
 * neither renders nor filters.
 * 18.0.9 and 18.0.10 left the container and the tool card byte-identical
 * too. 18.0.10's one transcript-adjacent change is a retry-replay path:
 * `retry()` now replays a stripped tool batch reusing `toolCallId`s, and
 * the event controller evicts the stale prior-turn tool card
 * (`#handleToolExecutionStart`) so the fresh card does not stack a
 * duplicate. The fold absorbs that out-of-band removal (it replans from
 * live children and restores unplanned patch entries, and session state
 * retires cross-run entries by call id), so no plugin change was needed.
 * `syncRetryHintRow()` (the F5-to-retry hint row) and `app.retry` gaining
 * `f5` as a default key are stock chrome the plugin neither renders nor
 * registers against. 18.0.11 left the container, the tool card and the
 * read group byte-identical too: the release's only container change is
 * an additive `resetStableEmission()` on the thinking-toggle path, a
 * ledger reset the plugin neither calls nor receives.
 * 18.1.0 and 18.1.1 left the read group byte-identical and the tool card
 * semantically unchanged: the four callbacks the binding observes
 * (`updateArgs`, `updateResult`, `setArgsComplete`, `setExpanded`) keep
 * identical signatures, and that file's only addition is a pure
 * `toolRenderName()` helper resolving an aliased wire name to its renderer
 * key. The container's additions — `rerenderOfferedBatch()`,
 * `getChildStartRow()` and a pinned-frontier warning — are frame recovery, a
 * deep-link row map and log bookkeeping; the six methods the fold wraps keep
 * their contracts. The release's transcript-side work is the new fullscreen
 * navigation surface (`rewind-selector.ts` replacing
 * `user-message-selector.ts`, plus `transcript-outline.ts`), which rewinds
 * through the same `truncateTranscriptFromMessage()`/`renderInitialMessages()`
 * pair the fold already observes; `/copy` moved onto that selector but still
 * harvests `SessionMessageEntry.message` rather than live component renders,
 * and `/usage` left the transcript for a fullscreen overlay this plugin
 * neither renders nor filters. Shortcuts are still called without `await` and
 * commands still awaited inside `try/catch`, both now wrapped in
 * `runScoped()`. The one new finalization path,
 * `#finalizeAbandonedPostToolSegments()`, finalizes abandoned post-tool
 * assistant blocks rather than tool rows, so it correctly does not stamp
 * `settledAt`.
 * 18.1.2 through 18.1.4 left the container, the tool card, the read group,
 * `ui-helpers.ts` and the event controller byte-identical, and the set of
 * `rebuildChatFromMessages()` call sites is unchanged. Three release facts
 * touch this plugin's world without changing its contracts. Esc-esc rewind on
 * a user message stopped forking a child session (`session.branch()`) and now
 * navigates the session tree in place, but it still finishes through the
 * `truncateTranscriptFromMessage()`/`renderInitialMessages()` pair the fold
 * observes, and `doubleEscapeAction` gained a `"tree"` value beside `rewind`
 * and `none`. The new `session/inline-edit-recovery.ts`
 * (`edit.recoverInlineEdits`, default on) turns a plain-text sloppy edit
 * payload into a real `toolCall` block, but only in an assistant message that
 * carries no tool call of its own, so a recovered card is created through the
 * ordinary tool path and never competes for stream state with a sibling call.
 * The plugin loader now skips a `~/.omp/plugins/node_modules` directory that no
 * `package.json` dependency entry claims; linked (symlinked) plugin directories
 * stay exempt, which is what keeps a development checkout loadable.
 * `@oh-my-pi/pi-tui` moved to 18.1.3 with Herdr-pane detection and DECRQM
 * `status` plumbing only: the `TUI` method set is identical and
 * `visibleWidth`/`truncateToWidth` are byte-identical (probed with an OSC
 * 8-wrapped string — width 5, truncation keeps the escape). 18.1.4 shipped
 * `@oh-my-pi/pi-coding-agent/src` and `@oh-my-pi/pi-tui/src` byte-identical to
 * 18.1.3 (1729 and 50 files, `diff -rq` clean): the release moved the model
 * catalog and the provider compat rules, which this plugin never reads.
 * 18.1.10 is the first pin move since 18.1.1 whose sources are **not**
 * byte-identical — 356 changed paths in `pi-coding-agent/src`, 5 in
 * `pi-tui/src`, 72 files added or removed. The release moved the edit engine
 * into `@oh-my-pi/pi-natives` (`EditSession`, native streaming previews) and
 * added agent reactions, assistant link targets and a workpool. Of the
 * thirteen files this plugin's contracts read, `transcript-container.ts`,
 * `read-tool-group.ts`, `config/keybindings.ts`, `session/shake-types.ts` and
 * `internal-urls/router.ts` are byte-identical; the six that changed keep
 * every contract. `updateResult(result, isPartial, toolCallId)` still carries
 * the id (the impl renames it `_toolCallId` and ignores it, exactly as
 * before), `rebuildChatFromMessages()` still has 18 call sites and still
 * replays results with the real id, the read deferral rule is unchanged
 * (`readArgsHaveTarget` then `readArgsCollapseIntoGroup`), tool cards are
 * still created in call order, and `session.shake()` still emits no event.
 * `runner.ts` changed only by renaming a type parameter (`TResult` → `R`);
 * `#RESERVED_SHORTCUTS` and `formatShakeSummary` are identical. The tool card
 * gained `updateStreamPreview(update)` fed by a new `tool_stream_update`
 * event, which drives native edit-diff previews inside the card — below the
 * row this plugin renders itself, and not a patched method.
 * 18.1.14 crosses 18.1.11-18.1.13 and is a small move: 54 changed paths in
 * `pi-coding-agent/src`, 5 in `pi-tui/src`, two files added
 * (`utils/tool-schema.ts`, `edit/hashline-compact.md`), none removed. Of the
 * files this plugin's contracts read, `transcript-container.ts`,
 * `tool-execution.ts`, `read-tool-group.ts`, `tool-activity.ts`,
 * `event-controller.ts`, `read-renderer.ts`, `internal-urls/router.ts`,
 * `shake-types.ts`, `session-maintenance.ts`, `runner.ts` and `composer.ts`
 * are byte-identical, and both modules the plugin imports by path
 * (`extensions/runner.ts`, `vibe/runtime.ts`) are unchanged. The release
 * reserves paste delivery (`PasteTarget.beginPaste`), arms an inline `/loop`
 * body only once dispatch confirms it was forwarded, and defers idle
 * compaction while an async wake is pending — none of which touches the
 * presentation surface. The five changed `modes/components` files are
 * dialogs and selectors (`ask-dialog`, `copy-selector`, `hook-editor`,
 * `rewind-selector`, `transcript-outline`), outside the patched set.
 * 18.1.15 is smaller still: 46 changed paths in `pi-coding-agent/src`, one in
 * `pi-tui/src`, nothing added or removed. Every file this plugin's contracts
 * read is byte-identical — the container, the tool card, the read group, the
 * activity component, the event controller, the read renderer, the
 * internal-URL router, `shake-types.ts`, `session-maintenance.ts`,
 * `input-controller.ts` and `composer.ts` — as are both modules the plugin
 * imports by path. `pi-tui/src/tui.ts` did change, and it matters here
 * because the mid-turn history publication depends on it: the release adds an
 * in-place resize transaction for Warp (which re-reports its size on
 * alt-buffer toggles, so borrowing the alt screen there self-sustains into a
 * flicker loop) behind `PI_TUI_RESIZE_IN_PLACE`. `resetDisplay()` is
 * unchanged and still the sole `\x1b[3J` emitter, so the scrollback-clearing
 * replay that lets a published row be retracted is intact. The rest of the
 * release is the advisor note budget, headless-browser tab freezing and idle
 * close (`browser.freezeOnTurnEnd`, `browser.idleCloseSec`,
 * `advisor.maxNotesPerUpdate`), and a pooled-turn yield contract in
 * `agent-session.ts`. The four changed `modes/components` files are the
 * advisor config, model browser, model hub and usage dashboard.
 * 18.1.17 crosses 18.1.16 in 77 changed `pi-coding-agent/src` paths,
 * adding notes-backed experimental context management, plan autosave and
 * loop-condition support; nothing is removed. The critical presentation
 * surface remains stable: the transcript container, tool card, read group,
 * tool activity, internal-URL router, composer, keybindings, shake types and
 * extension runner are byte-identical, as are both modules imported by path.
 * `event-controller.ts` adds only an idle-compaction timer refresh;
 * `read-renderer.ts` now sanitizes displayed lines; adjacent session changes
 * implement the opt-in context path. `pi-tui` adds Vim/editor-history and
 * cursor-shape support. The history seam is intact: container and composer
 * are byte-identical, `resetDisplay()` keeps arity zero, and `tui.ts` still
 * has exactly one `\x1b[3J` saved-scrollback erase. All 13 patch-surface
 * probes keep their measured arities.
 * 18.2.0 is a minor version bump (237 changed paths in `pi-coding-agent/src`,
 * 5 in `pi-tui/src`). It adds speculative execution, collab, inline mouse
 * click-to-focus on subagents (`tui.mouse`), and prompt caching instructions.
 * All 8 patched methods on `TranscriptContainer` and all 8 on `ToolExecutionComponent`
 * remain completely intact with identical signatures and arities. `ReadToolGroupComponent`,
 * `ToolActivityComponent`, `router.ts`, `shake-types.ts`, `keybindings.ts` and both
 * modules imported by path are byte-identical. `pi-tui` keeps `resetDisplay()`
 * byte-identical and retains the single `\x1b[3J` scrollback erase.
 * That floor is release metadata and must not be silently edited from this file.
 *
 * Local cache check (this workstation): `@oh-my-pi/pi-coding-agent@17.2.12`,
 * `17.3.1`, `17.3.4`, `17.3.8`, `17.4.0`, `17.4.2`, `18.0.0`, `18.0.1`, `18.0.3`, `18.0.6`, and `18.0.8` are present under the bun install cache
 * (or the root pin). Older copies are kept solely as reference sources for
 * verifying comments on leaf fingerprints, not as supported runtime targets.
 * The gate pin is 18.2.0 (root `node_modules`), verified from an isolated
 * `runtime/omp-18.2.0/` install before the root tree moved.
 * `runtime/omp-18.1.1/` is kept as the diff baseline, with the 18.1.3,
 * 18.1.4, 18.1.10, 18.1.14, 18.1.15 and 18.1.17 sources snapshotted under their
 * matching `runtime/omp-<version>/` directories for the same reason. The
 * fingerprint facts above come from the surface audit in
 * `runtime/omp-18.1.1/HOST-AUDIT-18.1.1.md`, the per-file semantic diff in
 * `runtime/omp-18.1.1/SEMANTIC-DIFF-18.1.1.md`, and the pin-move records in
 * `runtime/omp-18.1.3/PIN-MOVE-18.1.3.md`,
 * `runtime/omp-18.1.4/PIN-MOVE-18.1.4.md`,
 * `runtime/omp-18.1.10/PIN-MOVE-18.1.10.md`,
 * `runtime/omp-18.1.14/PIN-MOVE-18.1.14.md`,
 * `runtime/omp-18.1.15/PIN-MOVE-18.1.15.md`,
 * `runtime/omp-18.1.17/PIN-MOVE-18.1.17.md` and
 * `runtime/omp-18.2.0/PIN-MOVE-18.2.0.md`.
 * Activity-gated leaves (`setToolActivityVisible`) exist on TTSR, todo-reminder,
 * and late-diagnostics components. Fingerprints that require that method miss
 * cleanly when absent and leave the stock card native — they do not misclassify
 * into tool/read-group paths. User bash/eval and skill-card fingerprints do not
 * require the activity method; their compact rows still fail open to native when
 * content extraction fails.
 * Honest summary: critical tool/read-group/transcript compaction is verified on
 * the 18.2.0 pin and resolved via live capability probes on the instance;
 * optional compact chrome (inject, reminder, diagnostics) was confirmed on 17.3.1
 * and 17.3.4, remains under capability probes, and upon shape changes degrades
 * gracefully to stock native cards.
 *
 */

import { objectRecord } from "./object-record";
import type { RenderableBlock } from "./transcript-fold";

/**
 * Transcript methods required for discovery/install. A container missing
 * any of these is not a transcript host and stays entirely native.
 *
 * OMP 18.0.1 replaced the native-scrollback live region with block
 * lifecycle states plus history batches: `renderViewportTail` became
 * `renderViewport`, `isBlockUncommitted` became `canRemoveBlock`, and
 * `isBlockInLiveRegion` is gone. Retirement is now an offered batch the
 * terminal acknowledges.
 */
export const TRANSCRIPT_CRITICAL_METHODS = [
	"addChild",
	"render",
	"renderViewport",
	"liveRowCount",
	"peekFinalizedBatch",
	"acknowledgeFinalizedBatch",
	"canRemoveBlock",
	"blockStates",
] as const;

/**
 * Transcript methods the rebuild phase consumes (stock `clear` on the
 * exact transcript instance) and the replay path offers (`peekReplayBatch`,
 * 18.0.6). Optional: a host without them fails open to native
 * presentation rather than losing the session.
 */
export const TRANSCRIPT_OPTIONAL_METHODS = [
	"clear",
	"peekReplayBatch",
] as const;

/**
 * Transcript methods the fold patches (`TranscriptFold`). A strict subset
 * of the critical surface: every entry point that renders blocks must
 * replan the fold first, or a carrier would answer with stale rows and
 * the host would size the viewport from members that render nothing.
 */
export const TRANSCRIPT_FOLD_METHODS = [
	"render",
	"renderViewport",
	"liveRowCount",
	"peekFinalizedBatch",
] as const;

/**
 * Fold-patched transcript methods that only newer hosts expose. Each renders
 * blocks, so each must replan like the rest of the critical surface:
 * - `peekReplayBatch` (18.0.6): complete-history replay via `resetDisplay`.
 * - `renderTail`: the terminal's resize repaint of the trailing rows.
 * - `peekFlushBatch`: the zero-capacity shutdown flush of remaining history.
 * Patched only when the instance really has them: defining a method the host
 * never had would invent a capability the rest of the adapter probes for.
 */
export const TRANSCRIPT_FOLD_OPTIONAL_METHODS = [
	"peekReplayBatch",
	"renderTail",
	"peekFlushBatch",
] as const;

/** OMP 17.3.1 tool execution component surface. */
export const TOOL_METHODS = [
	"updateArgs",
	"updateResult",
	"setArgsComplete",
	"setExpanded",
	"seal",
	"setToolActivityVisible",
] as const;

/** Tool component methods the adapter wraps (subset of TOOL_METHODS). */
export const TOOL_PATCH_METHODS = [
	"updateArgs",
	"updateResult",
	"setArgsComplete",
	"setExpanded",
] as const;

/** OMP 17.3.1 read group component surface. */
export const READ_GROUP_METHODS = [
	"updateArgs",
	"updateResult",
	"removeEntry",
	"renameEntry",
] as const;

/** Read group methods the adapter wraps (superset incl. `setExpanded`). */
export const READ_GROUP_PATCH_METHODS = [
	"updateArgs",
	"updateResult",
	"setExpanded",
	"renameEntry",
	"removeEntry",
] as const;

/**
 * OMP 18.0.1 transcript block fold surface. All optional: the fold reads
 * them through the prototype chain and falls back to native behavior when
 * absent.
 *
 * 18.0.1 dropped the row-accounting contract the old native-scrollback
 * live region needed — `getTranscriptBlockVersion`,
 * `getTranscriptBlockSettledRows` and `setNativeScrollbackCommittedRows`
 * have no consumer left. Retirement now reads block lifecycle states, so
 * finalization plus the render itself carry everything the container asks
 * a block for.
 */
export const BLOCK_FOLD_METHODS = [
	"render",
	"isTranscriptBlockFinalized",
	"isDisplaceableBlock",
	"seal",
] as const;

/**
 * Append-only publication members the fold declares on a folded block.
 *
 * Deliberately outside {@link BLOCK_FOLD_METHODS}: the container captures a
 * block's presentation mode once, when it first syncs the child, and keeps
 * calling these for the block's whole life. Restoring them with the rest of
 * the fold patch — a release to native, a quarantine, a rollback — would
 * leave the container calling a method that no longer exists. They stay
 * declared instead, and report nothing published whenever the fold owns
 * nothing.
 */
export const BLOCK_PUBLICATION_MEMBERS = [
	"transcriptBlockMode",
	"getTranscriptStableRows",
	"renderTranscriptStableRows",
] as const;

/**
 * Exact TUI methods the rebuild phase consumes. Optional: consumed only
 * with native fail-open when absent.
 */
export const TUI_OPTIONAL_METHODS = ["resetDisplay"] as const;

function stringAt(args: readonly unknown[], index: number): string | undefined {
	const value = args[index];
	return typeof value === "string" ? value : undefined;
}

export function isToolComponent(value: unknown): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	// Mirror leafCapabilities kind ranking: a full read-group surface wins
	// over the generic tool surface. Partial overlap stays a tool.
	let readGroup = true;
	for (const name of READ_GROUP_METHODS) {
		if (typeof candidate[name] !== "function") {
			readGroup = false;
			break;
		}
	}
	if (readGroup) return false;
	for (const name of TOOL_METHODS) {
		if (typeof candidate[name] !== "function") return false;
	}
	return true;
}

export function isReadGroupComponent(value: unknown): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	// Same READ_GROUP_METHODS every-check leafCapabilities uses for kind.
	for (const name of READ_GROUP_METHODS) {
		if (typeof candidate[name] !== "function") return false;
	}
	return true;
}

/**
 * Extract the read call's target path. `path` is canonical; `file_path` is
 * the legacy alias still tolerated by the stock read tool schema. Mirrors
 * stock `readArgsTarget` in `read-tool-group.ts`.
 */
export function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args))
		return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

/**
 * Whether a read collapses into {@link ReadToolGroupComponent} rather than a
 * full `ToolExecutionComponent`. Stock (`readArgsCollapseIntoGroup`, OMP
 * 18.0.1): filesystem/external targets and `xd://` collapse; internal URLs
 * the host router can resolve (`skill://`, `agent://`, `memory://`, …)
 * render as full tool cards so resolved content stays visible.
 *
 * The plugin cannot call stock's `InternalUrlRouter` from the extension
 * process, so the full-card schemes are listed explicitly. Unknown
 * scheme-less / filesystem paths collapse (group presentation). Drift risk
 * is limited to new internal schemes defaulting to group until listed —
 * the inverse (treating a groupable path as a full card) is worse because
 * a single full-card read state previously poisoned every tool's order
 * pairing on restore.
 */
const FULL_CARD_READ_SCHEME =
	/^(?:skill|agent|memory|vault|history|artifact|omp|rule|security|mcp|issue|pr|local|ssh):\/\//i;

export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (target === undefined) return false;
	if (target.startsWith("xd://")) return true;
	return !FULL_CARD_READ_SCHEME.test(target);
}

/**
 * Stock TTSR notification fingerprint (OMP 17.3.1 `TtsrNotificationComponent`):
 * `addRules` + expand/activity controls, without the tool execution surface.
 * Todo reminders share `setToolActivityVisible` but never expose `addRules`.
 */
export function isTtsrNotificationComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.addRules !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	// Tool leaves also expose setToolActivityVisible; the call surface is the
	// discriminator so a future host method mix-in cannot misclassify a tool.
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	return true;
}

/**
 * Stock todo-reminder fingerprint (OMP 17.3.4 `TodoReminderComponent`):
 * activity visibility + render only. Rejects TTSR (`addRules`/`setExpanded`/
 * `isExpanded`), tool leaves, and read groups so only the yellow incomplete-
 * todo card is matched among those surfaces. Note: `StrippedToolCallsPlaceholder`
 * collides on methods alone; `#patchTodoReminder` contains that by probing
 * `todoReminderFromComponent` before any DescriptorPatch install.
 */
export function isTodoReminderComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	// TTSR and late-diagnostics expose expand controls; tools expose the
	// execution surface. Any of those means this is not a todo reminder.
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.setExpanded === "function") return false;
	if (typeof candidate.isExpanded === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	return true;
}

/**
 * Shared public surface of stock user-initiated bash/eval execution blocks
 * (OMP 17.3.4 `BashExecutionComponent` / `EvalExecutionComponent`): streaming
 * output + completion + transcript finalization + expand. Neither leaf exposes
 * the tool/TTSR/todo activity surfaces; those rejects keep the fingerprints
 * out of the tool/read-group/inject/reminder paths.
 */
function hasUserExecutionSurface(candidate: Record<string, unknown>): boolean {
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.appendOutput !== "function") return false;
	if (typeof candidate.setComplete !== "function") return false;
	if (typeof candidate.isTranscriptBlockFinalized !== "function") return false;
	if (typeof candidate.getOutput !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	// Tool / TTSR / todo activity controls never appear on user executions.
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.setToolActivityVisible === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	return true;
}

/**
 * Stock user bash execution fingerprint (`!` / `!!` → `BashExecutionComponent`):
 * shared execution surface + `getCommand`, without `getCode`. Host components
 * under `src/modes/components/` were checked: only `bash-execution.ts` exposes
 * `appendOutput`+`setComplete`+`getCommand`; no other leaf collides.
 */
export function isBashExecutionComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (!hasUserExecutionSurface(candidate)) return false;
	if (typeof candidate.getCommand !== "function") return false;
	// Eval uses getCode; mutual exclusion keeps the two paths distinct.
	if (typeof candidate.getCode === "function") return false;
	return true;
}

/**
 * Stock user eval/python execution fingerprint (`$` / `$$` →
 * `EvalExecutionComponent`, transcript role `pythonExecution`): shared
 * execution surface + `getCode`, without `getCommand`. Host scan: only
 * `eval-execution.ts` exposes `appendOutput`+`setComplete`+`getCode`.
 */
export function isEvalExecutionComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (!hasUserExecutionSurface(candidate)) return false;
	if (typeof candidate.getCode !== "function") return false;
	if (typeof candidate.getCommand === "function") return false;
	return true;
}

/**
 * Stock skill card fingerprint (OMP 17.3.4 `SkillMessageComponent`):
 * expand + render, with the host parameter-property `message` carrying
 * `customType === "skill-prompt"` (session/messages.ts:42,
 * `SKILL_PROMPT_MESSAGE_TYPE`). TS `private readonly message` is a runtime
 * own field — same seam as `isCompactCustomMessage`. Rejects tool/TTSR/
 * activity surfaces so a method mix-in cannot misclassify those leaves.
 */
export function isSkillMessageComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	// Tools / TTSR / late-diagnostics / todo activity never appear on skill.
	if (typeof candidate.setToolActivityVisible === "function") return false;
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	const message = objectRecord(candidate.message);
	// Pin literal to OMP 17.3.4 session/messages.ts:42 SKILL_PROMPT_MESSAGE_TYPE.
	return message.customType === "skill-prompt";
}

/**
 * Stock late-LSP-diagnostics fingerprint (OMP 17.3.4
 * `LateDiagnosticsMessageComponent`): expand + activity + render, with the
 * host parameter-property `files` array (late-diagnostics-message.ts:21).
 * The transcript message's customType `"lsp-late-diagnostic"`
 * (session/messages.ts:43) is NOT retained on the component — only `files`.
 * Rejects tool/TTSR execution surfaces; `ToolActivityContainer` collides on
 * methods but never exposes `files`.
 */
export function isLateDiagnosticsMessageComponent(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setExpanded !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	if (!Array.isArray(candidate.files)) return false;
	// Tool / TTSR / read-group execution surface.
	if (typeof candidate.addRules === "function") return false;
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.seal === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	return true;
}

/**
 * Stock notice of finished background activity (OMP 18.0.1
 * `transcript-render-helpers.ts`): a `ToolActivityContainer` wrapping exactly
 * one `TranscriptBlock` whose children are all `Text` leaves — one line per
 * reported process or job.
 *
 * Both host builders produce that identical shape: `buildLaunchCompletionBlock`
 * (supervised process summaries) and `buildAsyncResultBlock` (background job
 * results). Nothing structural tells them apart, and no host method exposes
 * their kind, so this is deliberately one class of block: the plugin treats
 * every finished-background-activity notice the same way, and a caller that
 * needs to distinguish them cannot use this probe.
 *
 * Method rejects come first because two stock cards share the exact structure:
 * `ToolExecutionComponent` and `ReadToolGroupComponent` are also containers
 * holding one content box of text leaves, so only their execution surface tells
 * them apart from a notice. Without those rejects an unbound stock tool card
 * would be mistaken for one. The rejects deliberately avoid every name in
 * {@link BLOCK_FOLD_METHODS} (`render`, `seal`, finalize/displace probes):
 * the fold installs those on each member it owns, so a block matched once would
 * stop matching on the next render and silently fall out of the run.
 *
 * The remaining activity-gated neighbors are rejected by shape alone:
 * - `TodoReminderComponent` — two children (spacer + box card);
 * - `TtsrNotificationComponent` — two children (spacer + box card);
 * - `LateDiagnosticsMessageComponent` — one `Text` child, so the single-child
 *   slot holds a leaf instead of a block of lines;
 * - `StrippedToolCallsPlaceholder` — a `Text` leaf, so it has no `children`.
 * The generic `hideWithToolActivity` wrapper of stock `present` is the same
 * `ToolActivityContainer` class but always wraps `[spacer, content]`, so its
 * two children reject it too.
 */
export function isBackgroundCompletionBlock(
	value: unknown,
): value is RenderableBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.render !== "function") return false;
	if (typeof candidate.setToolActivityVisible !== "function") return false;
	// Tool / read-group / TTSR execution surfaces.
	if (typeof candidate.updateArgs === "function") return false;
	if (typeof candidate.updateResult === "function") return false;
	if (typeof candidate.setArgsComplete === "function") return false;
	if (typeof candidate.removeEntry === "function") return false;
	if (typeof candidate.renameEntry === "function") return false;
	if (typeof candidate.addRules === "function") return false;
	if (!Array.isArray(candidate.children) || candidate.children.length !== 1)
		return false;
	const lines = objectRecord(candidate.children[0]).children;
	if (!Array.isArray(lines) || lines.length === 0) return false;
	for (const line of lines) {
		if (!line || typeof line !== "object") return false;
		if (Array.isArray((line as Record<string, unknown>).children)) return false;
	}
	return true;
}

/**
 * OMP 17.3.1 argument positions. `updateArgs` carries
 * `(payload, toolCallId)`; the read group's `updateResult` carries
 * `(result, isPartial, toolCallId)` while the tool component's
 * `updateResult` carries `(result, isPartial)`. `renameEntry` takes
 * `(oldId, newId)`, `removeEntry` takes `(toolCallId)` and `setExpanded`
 * takes a single boolean.
 */
export function updateArgsToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 1);
}

export function updateArgsPayload(args: readonly unknown[]): unknown {
	return args[0];
}

export function updateResultToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 2);
}

export function updateResultPayload(args: readonly unknown[]): unknown {
	return args[0];
}

export function updateResultIsPartial(args: readonly unknown[]): boolean {
	return args[1] === true;
}

export function renameEntryIds(args: readonly unknown[]): {
	oldId: string | undefined;
	newId: string | undefined;
} {
	return { oldId: stringAt(args, 0), newId: stringAt(args, 1) };
}

export function removeEntryToolCallId(
	args: readonly unknown[],
): string | undefined {
	return stringAt(args, 0);
}

export function setExpandedValue(args: readonly unknown[]): boolean {
	return args[0] === true;
}
