/**
 * Tern Surface Protocol (TSP) presentation for compacted components.
 *
 * Inside a TSP terminal (Tern) the host stops painting rows. Every transcript
 * block hands the terminal a semantic node through `describe(cx)`, and only
 * a component without one, or whose `describe` returns nothing, is painted
 * through `render(cx.cols)` as a `rows` node, which Tern badges as a
 * fallback. A `render` patch alone therefore leaves every stock card native
 * there. Each component the plugin presents compactly also answers
 * `describe`: its compact rows as one unwrapped `text` node, an invisible
 * node when it presents nothing, and the stock description whenever it stays
 * native.
 *
 * The compact rows are ANSI-styled; the host's own `rowsText` (the helper
 * stock components use for pre-rendered rows) maps their colours back to
 * theme tokens. It ships with the protocol (18.4.4), so it is imported
 * dynamically: an older host loads this module unchanged and never calls
 * `describe`.
 */

import { Container } from "@oh-my-pi/pi-tui";

import { objectRecord } from "./object-record";
import { resolveInstanceMethod } from "./presentation-patches";

type Lines = readonly string[];

// Dynamic: `native/spans` does not exist on hosts before 18.4.4, where a
// static import would fail the whole plugin's load.
const rowsText = await import("@oh-my-pi/pi-tui/native/spans").then(
	(spans): ((lines: Lines) => object) | undefined => spans.rowsText,
	() => undefined,
);

/**
 * The few fixed colours the plugin paints (`fixedForeground` in render.ts)
 * are no theme colour, so `rowsText` cannot map them back and would drop
 * them. Their basic SGR equivalents map to the semantic tokens that keep
 * their meaning: green additions, resolve and stats ink (`success`), rust
 * removals and reject (`error`), purple computer use (`accent`).
 */
const FIXED_COLOR_SGR = (
	[
		["#A4D734", 32],
		["#A1471A", 31],
		["#8D2A88", 35],
	] as const
).flatMap(([hex, sgr]) => {
	const truecolor = Bun.color(hex, "ansi-16m");
	return truecolor ? [[truecolor, `\x1b[${sgr}m`] as const] : [];
});

function themedLines(lines: Lines): Lines {
	return lines.map((line) => {
		let themed = line;
		for (const [truecolor, basic] of FIXED_COLOR_SGR)
			themed = themed.replaceAll(truecolor, basic);
		return themed;
	});
}

/** The host's `describe`, taken off the prototype chain before patching. */
export type NativeDescribe = (this: object, cx?: unknown) => unknown;

/** The host's `handleNativeEvent`, taken off the prototype chain before patching. */
export type NativeHandle = (this: object, event: unknown) => void;

/** What a click on a compact row sends: show that component's stock card. */
export const REVEAL_ACTION = "omp-compact.reveal";
/** What a click on a revealed card's compact row sends: compact it again. */
export const CONCEAL_ACTION = "omp-compact.conceal";
/** What a click on a run's stats row sends: show or hide the calls it hid. */
export const HIDDEN_CALLS_ACTION = "omp-compact.hidden-calls";

/** One component's compact rows inside a node; a click on them names it. */
export interface RowsSegment {
	readonly owner: object;
	readonly lines: Lines;
}

/** The stock presentation a revealed component shows under its compact rows. */
export interface StockView {
	readonly describe: NativeDescribe | undefined;
	readonly render: (this: object, width: number) => Lines;
	readonly handle: NativeHandle | undefined;
}

/**
 * The description the reconciler would ask `component` for, or `undefined`
 * where it paints rows instead. Mirrors its rule (`reconcile.ts`
 * `#resolve`): a `Container` subclass that paints its own rows but inherits
 * the plain column description has none. Read before patching, while the
 * instance's own `render` and `describe` are still the host's.
 */
export function stockDescribe(component: object): NativeDescribe | undefined {
	const describe = resolveInstanceMethod(component, "describe");
	if (
		describe === Container.prototype.describe &&
		resolveInstanceMethod(component, "render") !== Container.prototype.render
	)
		return undefined;
	return describe as NativeDescribe | undefined;
}

/** Stock `EMPTY_NODE`: mounted, never laid out, so it takes no room. */
export const HIDDEN_NODE: object = Object.freeze({
	k: "col",
	p: Object.freeze({ hidden: true }),
});

/**
 * Whether a stock description draws nothing: absent, hidden, or an empty
 * container (a tool-only assistant turn describes as a childless `col`).
 */
export function describesNothing(described: unknown): boolean {
	const node = objectRecord(described);
	if (typeof node.k !== "string") return true;
	if (objectRecord(node.p).hidden === true) return true;
	return (
		(node.k === "col" || node.k === "row") &&
		!(Array.isArray(node.c) && node.c.length > 0)
	);
}

/**
 * The surface width a describe context reports. The reconciler paints its
 * own `rows` fallback at `max(1, cx.cols)`; a context without a usable width
 * falls back to the process terminal.
 */
export function describeWidth(cx: unknown): number {
	const cols = objectRecord(cx).cols;
	if (typeof cols === "number" && Number.isFinite(cols) && cols >= 1)
		return Math.trunc(cols);
	return terminalColumns();
}

/** The process terminal's width, or 80 when stdout is not a terminal. */
export function terminalColumns(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns > 0 ? columns : 80;
}

function sameLines(left: Lines, right: Lines): boolean {
	// Renderers return a fresh array per call; one mutated in place would
	// compare equal to itself here and keep its stale node.
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++)
		if (left[index] !== right[index]) return false;
	return true;
}

function sameSegments(
	left: readonly RowsSegment[],
	right: readonly RowsSegment[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const a = left[index];
		const b = right[index];
		if (!a || !b || a.owner !== b.owner || !sameLines(a.lines, b.lines))
			return false;
	}
	return true;
}

function textNode(lines: Lines, cols: number): Record<string, unknown> {
	return objectRecord(
		rowsText?.(themedLines(lines)) ?? { k: "rows", p: { cols, lines } },
	);
}

function clickable(
	base: Record<string, unknown>,
	act: string,
	title: string,
	key?: string,
): object {
	return {
		...base,
		p: { ...objectRecord(base.p), actions: { click: act }, title },
		...(key !== undefined && { key }),
	};
}

/** Rows as one text node a click on sends `act` to its owner. */
export function clickableRows(
	lines: Lines,
	cols: number,
	act: string,
	title: string,
): object {
	return clickable(textNode(lines, cols), act, title);
}

/**
 * The nodes compact components describe as, reused while their lines are
 * unchanged: the reconciler skips a component whose description is the
 * object it returned last frame, so an unchanged compact row costs no diff
 * and no wire traffic.
 *
 * Compact rows are clickable. Each component's rows in a node are one keyed
 * child, so a click on them reaches the node's owner as a `REVEAL_ACTION`
 * at that key, and {@link handle} reveals the component the rows belong to.
 * A revealed component describes as its compact rows (a click compacts it
 * again) over its stock card. The stock card sits in a proxy component, so
 * the reconciler routes the card's own events (expand, copy) to it, under
 * the stock key paths, and the proxy hands them to the stock handler.
 */
export class RowsNodes {
	#plain = new WeakMap<object, { cols: number; lines: Lines; node: object }>();
	#compact = new WeakMap<
		object,
		{ cols: number; segments: readonly RowsSegment[]; node: object }
	>();
	#revealedNodes = new WeakMap<
		object,
		{ cols: number; lines: Lines; node: object }
	>();
	#revealed = new WeakSet<object>();
	#proxies = new WeakMap<object, object>();

	/** Plain rows: a stock block that paints its own rows, never clickable. */
	node(owner: object, lines: Lines, cols: number): object {
		if (lines.length === 0) return HIDDEN_NODE;
		const cached = this.#plain.get(owner);
		if (cached && cached.cols === cols && sameLines(cached.lines, lines))
			return cached.node;
		const node = textNode(lines, cols);
		this.#plain.set(owner, { cols, lines, node });
		return node;
	}

	/** The compact rows of one or more components, each clickable. */
	compact(
		owner: object,
		segments: readonly RowsSegment[],
		cols: number,
	): object {
		const shown = segments.filter((segment) => segment.lines.length > 0);
		if (shown.length === 0) return HIDDEN_NODE;
		const cached = this.#compact.get(owner);
		if (cached && cached.cols === cols && sameSegments(cached.segments, shown))
			return cached.node;
		const node = {
			k: "col",
			p: {},
			c: shown.map((segment, index) =>
				clickable(
					textNode(segment.lines, cols),
					REVEAL_ACTION,
					"Show the full card",
					String(index),
				),
			),
		};
		this.#compact.set(owner, { cols, segments: shown, node });
		return node;
	}

	/** A revealed component: its compact rows over its stock card. */
	revealed(
		owner: object,
		lines: Lines,
		cols: number,
		stock: StockView,
	): object {
		if (lines.length === 0) return HIDDEN_NODE;
		const cached = this.#revealedNodes.get(owner);
		if (cached && cached.cols === cols && sameLines(cached.lines, lines))
			return cached.node;
		const node = {
			k: "col",
			p: {},
			c: [
				clickable(textNode(lines, cols), CONCEAL_ACTION, "Compact again", "r"),
				this.#proxy(owner, stock),
			],
		};
		this.#revealedNodes.set(owner, { cols, lines, node });
		return node;
	}

	/** One component's own compact rows, revealed or not. */
	present(owner: object, lines: Lines, cols: number, stock: StockView): object {
		return this.#revealed.has(owner)
			? this.revealed(owner, lines, cols, stock)
			: this.compact(owner, [{ owner, lines }], cols);
	}

	isRevealed(owner: object): boolean {
		return this.#revealed.has(owner);
	}

	/**
	 * A click on compact rows `owner` described: reveal the component the
	 * clicked rows belong to, or compact a revealed one again. False for any
	 * other event, which belongs to the stock handler.
	 */
	handle(owner: object, event: unknown): boolean {
		const record = objectRecord(event);
		if (record.type !== "action") return false;
		if (record.act === CONCEAL_ACTION) {
			this.#revealed.delete(owner);
			return true;
		}
		if (record.act !== REVEAL_ACTION) return false;
		const key = record.key;
		const segments = this.#compact.get(owner)?.segments;
		const target =
			typeof key === "string" && /^\d+$/.test(key)
				? segments?.[Number(key)]?.owner
				: undefined;
		if (target) this.#revealed.add(target);
		return true;
	}

	#proxy(owner: object, stock: StockView): object {
		let proxy = this.#proxies.get(owner);
		if (proxy) return proxy;
		const { describe, render, handle } = stock;
		proxy = {
			render: (width: number): Lines => render.call(owner, width),
			...(describe && {
				describe: (cx?: unknown): unknown => describe.call(owner, cx),
			}),
			...(handle && {
				handleNativeEvent: (event: unknown): void => handle.call(owner, event),
			}),
		};
		this.#proxies.set(owner, proxy);
		return proxy;
	}
}

/**
 * `describe` and `handleNativeEvent` wrappers for a leaf the plugin decides
 * per paint, like its `render` wrapper: `compactRows` answers the compact
 * rows, or `undefined` to keep the stock description. The compact rows are
 * clickable (see {@link RowsNodes}); every other event goes to the stock
 * handler. Empty when the leaf has no stock description: the reconciler
 * then paints the patched `render`, which already answers compactly. Read
 * before the leaf's patch is installed, while its methods are the host's.
 */
export function compactNativeMembers(
	component: object,
	compactRows: (block: object, width: number) => Lines | undefined,
	nodes: RowsNodes,
): Record<string, PropertyDescriptor> {
	const native = stockDescribe(component);
	const render = resolveInstanceMethod(component, "render") as
		| StockView["render"]
		| undefined;
	if (!native || !render) return {};
	const stock: StockView = {
		describe: native,
		render,
		handle: resolveInstanceMethod(component, "handleNativeEvent") as
			| NativeHandle
			| undefined,
	};
	return {
		describe: {
			configurable: true,
			writable: true,
			value(this: object, cx?: unknown): unknown {
				const width = describeWidth(cx);
				const rows = compactRows(this, width);
				if (rows === undefined) return native.call(this, cx);
				return nodes.present(this, rows, width, stock);
			},
		},
		handleNativeEvent: {
			configurable: true,
			writable: true,
			value(this: object, event: unknown): void {
				if (!nodes.handle(this, event)) stock.handle?.call(this, event);
			},
		},
	};
}
