import {
	DEFAULT_DISPLAY_CYCLE_KEY,
	validateDisplayCycleKey,
} from "./display-cycle";

// =============================================================================
// Structural host types (no runtime dependency on the host packages)
// =============================================================================

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
}

export interface KeybindingsLike {
	matches(data: string, action: string): boolean;
}

export interface ComponentLike {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

export interface SettingsUiLike {
	custom<T>(
		factory: (
			tui: unknown,
			theme: ThemeLike,
			keybindings: KeybindingsLike,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
	): Promise<T>;
}

export interface CommandApiLike<Ctx> {
	getCommands(): readonly { name: string }[];
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: Ctx) => Promise<void>;
		},
	): void;
}

/**
 * Shortcut-registration slice of the host `ExtensionAPI`. Structural, like
 * `CommandApiLike`: the plugin never depends on the host packages at runtime.
 * There is deliberately no counterpart for removal — the host interface has
 * none, which is why a chord change needs a restart.
 */
export interface ShortcutApiLike<Ctx> {
	registerShortcut(
		shortcut: string,
		options: {
			description?: string;
			handler: (ctx: Ctx) => Promise<void> | void;
		},
	): void;
}

// =============================================================================
// Command registration
// =============================================================================

const PREFERRED_COMMAND = "compact-settings";
const FALLBACK_COMMAND = "omp-compact-settings";
const MAX_NUMBERED_FALLBACK = 99;

/**
 * Pick the settings command name, avoiding occupied names: the preferred
 * `compact-settings`, else `omp-compact-settings`, else a deterministic
 * numbered `omp-compact-settings-N` (N from 2). Always returns a usable name
 * (last-resort highest number) rather than throwing.
 * When all 99 numbered fallbacks are occupied, returns the highest number
 * as a last resort rather than throwing.
 */
export function chooseSettingsCommandName(
	registered: readonly string[],
): string {
	if (!registered.includes(PREFERRED_COMMAND)) return PREFERRED_COMMAND;
	if (!registered.includes(FALLBACK_COMMAND)) return FALLBACK_COMMAND;
	for (let n = 2; n <= MAX_NUMBERED_FALLBACK; n++) {
		const candidate = `${FALLBACK_COMMAND}-${n}`;
		if (!registered.includes(candidate)) return candidate;
	}
	return `${FALLBACK_COMMAND}-${MAX_NUMBERED_FALLBACK}`;
}

/**
 * Register the settings command. Runs unconditionally — the command must stay
 * available even when the plugin runtime is globally disabled.
 *
 * Returns the name registered, or `undefined` when the host rejects the
 * registration: a host without command support (older runtime, RPC shim) must
 * not take the plugin down, every other feature keeps working.
 */
export function registerSettingsCommand<Ctx>(
	pi: CommandApiLike<Ctx>,
	options: {
		description: string;
		handler: (args: string, ctx: Ctx) => Promise<void>;
	},
): string | undefined {
	let names: readonly string[] = [];
	try {
		names = pi.getCommands().map((command) => command.name);
	} catch {
		// getCommands unavailable (extension runtime not ready): proceed with
		// the preferred name and let the runtime surface a conflict if any.
		names = [];
	}
	const name = chooseSettingsCommandName(names);
	try {
		pi.registerCommand(name, options);
	} catch {
		// A host without command registration support (older runtime, RPC
		// shim) must not take the plugin down: every other feature keeps
		// working.
		return undefined;
	}
	return name;
}

/**
 * Register the display-cycle shortcut. Runs unconditionally, like the settings
 * command: the key must keep working when the runtime is globally disabled —
 * that state is one step of the cycle, and a user who turned the plugin off
 * with the key has to be able to turn it back on with the same key.
 *
 * Returns the chord actually registered, or `undefined` when the persisted
 * chord is unusable. An occupied chord is dropped by the host with only a log
 * line, so it is refused here and the default is registered instead — a
 * working default beats a silently dead key.
 */
export function registerDisplayCycleShortcut<Ctx>(
	pi: ShortcutApiLike<Ctx>,
	chord: string,
	options: {
		description: string;
		handler: (ctx: Ctx) => Promise<void> | void;
	},
): string | undefined {
	const key =
		validateDisplayCycleKey(chord) === undefined
			? chord
			: DEFAULT_DISPLAY_CYCLE_KEY;
	try {
		pi.registerShortcut(key, options);
	} catch {
		// A host without shortcut support (older runtime, RPC shim) must not
		// take the plugin down: every other feature keeps working.
		return undefined;
	}
	return key;
}
