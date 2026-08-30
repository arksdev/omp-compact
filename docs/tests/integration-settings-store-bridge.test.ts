import { afterAll, expect } from "bun:test";
import { DEFAULT_SETTINGS } from "../../.omp-plugin/config";
import { KEY_ESCAPE, KEY_SPACE } from "../../.omp-plugin/settings-ui";
import {
	addTool,
	type BootedPlugin,
	beginRun,
	bootWithMode,
	bootWithTranscript,
	cleanupGeneratedDirs,
	finishTool,
	groupedRead,
	lastBootSettingsPath,
	shutdown,
	stockTest,
	visibleRows,
} from "./integration-harness";

afterAll(cleanupGeneratedDirs);

// ---------------------------------------------------------------------------
// Per-instance settings store (upgrade2 item 1 hardening): two plugin
// instances in one process must never share settings state.
// ---------------------------------------------------------------------------

stockTest("two plugin instances keep isolated settings snapshots", async () => {
	// instance A boots with compactPaths=false…
	const a = await bootWithMode("live", { compactPaths: false });
	// …then instance B boots with compactPaths=true in the same process
	// (the shared harness config file is rewritten, but each instance's
	// store was created and loaded at its own boot)
	const b = await bootWithTranscript();
	// A's rendering still uses A's snapshot: a module-global store would
	// leak B's settings into A's displayPaths closure
	await beginRun(a);
	await groupedRead(a, "/tmp/iso.ts", "iso-read");
	const live = visibleRows(a.transcript).join("\n");
	expect(live).toContain("• read /tmp/iso.ts");
	expect(live).not.toContain("• read iso.ts");
	await shutdown(a);
	await shutdown(b);
});

// ---------------------------------------------------------------------------
// Host-settings bridge (upgrade2 item 6): the settings menu must open and
// save ordinary plugin options even when no verified live main-session
// Settings instance exists. This stock runtime NEVER initializes the
// exported global `settings` Proxy — it throws "Settings not initialized.
// Call Settings.init() first." on any access — so the plugin must resolve
// host settings through the per-AgentSession instance and, when the live
// main session is unavailable, keep plugin rows savable while host rows are
// visibly unavailable.
// ---------------------------------------------------------------------------

interface MountedDialog {
	handleInput(data: string): void;
	render(width: number): readonly string[];
}

function mountDialog(booted: BootedPlugin): {
	get mounted(): MountedDialog | undefined;
	/** Resolves with the dialog's finished value (saved draft or undefined). */
	result: Promise<unknown>;
} {
	let mounted: MountedDialog | undefined;
	let resolveResult!: (result: unknown) => void;
	// openSettingsDialog awaits the promise `custom` returns; that promise is
	// resolved by the dialog's `done` callback, so sharing it here exposes
	// the dialog result without relying on the (void) command handler.
	const result = new Promise<unknown>((resolve) => {
		resolveResult = resolve;
	});
	booted.context.ui.custom = (async <T>(
		factory: (
			_tui: unknown,
			_theme: unknown,
			_keybindings: unknown,
			done: (result: T) => void,
		) => unknown,
	): Promise<T> => {
		mounted = factory(
			null,
			booted.host.getTheme(),
			{ matches: () => false },
			(result) => resolveResult(result),
		) as MountedDialog;
		return result as Promise<T>;
	}) as never;
	return {
		get mounted() {
			return mounted;
		},
		result,
	};
}

async function waitForDialog(
	mount: ReturnType<typeof mountDialog>,
	timeoutMs = 2_000,
): Promise<MountedDialog> {
	const start = Date.now();
	while (!mount.mounted) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("settings dialog did not mount");
		}
		await Bun.sleep(5);
	}
	return mount.mounted;
}

function pluginConfigPath(): string {
	// The path of the settings file written for the current boot (unique per
	// boot, so parallel test files never clobber one another).
	if (lastBootSettingsPath === undefined) {
		throw new Error("pluginConfigPath called before any boot wrote settings");
	}
	return lastBootSettingsPath;
}

stockTest(
	"settings menu opens with host rows unavailable and saves plugin-only changes when no live session settings exist",
	async () => {
		const booted = await bootWithTranscript();
		const handler = booted.commandHandlers.get("compact-settings");
		expect(handler).toBeDefined();
		const mount = mountDialog(booted);
		const commandDone = handler?.("", booted.context);
		const dialog = await waitForDialog(mount);
		// Host rows render n/a (no live main-session Settings instance): they
		// must never claim success when unavailable.
		const rows = dialog.render(120).map((l) => Bun.stripANSI(l));
		expect(
			rows.some((l) => l.includes("Recap summary") && l.includes("n/a")),
		).toBe(true);
		expect(
			rows.some((l) => l.includes("Thinking blocks") && l.includes("n/a")),
		).toBe(true);
		// Plugin rows stay usable: toggle Global compact and save.
		dialog.handleInput(KEY_SPACE);
		dialog.handleInput("s");
		const saved = await mount.result;
		expect(saved).toMatchObject({ enabled: false });
		await commandDone;
		expect(booted.notifications).toContain("omp-compact settings saved");
		// The plugin JSON persisted the plugin change but left the host
		// preferences untouched.
		const persisted = JSON.parse(
			await Bun.file(pluginConfigPath()).text(),
		) as Record<string, unknown>;
		expect(persisted.enabled).toBe(false);
		expect(persisted.host).toEqual(DEFAULT_SETTINGS.host);
		// Nothing reported the stock global-proxy failure.
		expect(
			booted.notifications.some((n) => n.includes("Settings not initialized")),
		).toBe(false);
		await shutdown(booted);
	},
);

stockTest(
	"settings menu cancel writes nothing when host settings are unavailable",
	async () => {
		const booted = await bootWithTranscript();
		const handler = booted.commandHandlers.get("compact-settings");
		expect(handler).toBeDefined();
		const before = await Bun.file(pluginConfigPath()).text();
		const mount = mountDialog(booted);
		const commandDone = handler?.("", booted.context);
		const dialog = await waitForDialog(mount);
		dialog.handleInput(KEY_ESCAPE);
		const saved = await mount.result;
		expect(saved).toBeUndefined();
		await commandDone;
		expect(await Bun.file(pluginConfigPath()).text()).toBe(before);
		expect(booted.notifications).not.toContain("omp-compact settings saved");
		await shutdown(booted);
	},
);

stockTest(
	"the settings command refuses to open a dialog in a headless session",
	async () => {
		// A subagent or RPC session has no interactive terminal. Opening the
		// dialog there would await a result nobody can produce, hanging the
		// command; the plugin must decline and say why instead.
		const booted = await bootWithTranscript();
		const handler = booted.commandHandlers.get("compact-settings");
		expect(handler).toBeDefined();
		const before = await Bun.file(pluginConfigPath()).text();
		// Same context, hasUI false: the ui seam stays live so the refusal
		// path is exercised, not a missing-notify fallback.
		await handler?.("", { ...booted.context, hasUI: false });
		expect(booted.dialogs).toHaveLength(0);
		expect(booted.notifications).toContain(
			"omp-compact settings require an interactive terminal",
		);
		// Declining is not a save: the config file is untouched.
		expect(await Bun.file(pluginConfigPath()).text()).toBe(before);
		await shutdown(booted);
	},
);

// ---------------------------------------------------------------------------
// Env-override honesty on save (E01): with a hard env override in force the
// save still succeeds and persists the requested values, and exactly ONE
// notification carries both facts — the save and the effective value that
// stays in force. Never a warning plus a generic success that implies the
// saved value took effect.
// ---------------------------------------------------------------------------

stockTest(
	"settings save emits one notification when a hard env override masks the saved values",
	async () => {
		const previousMode = Bun.env.OMP_COMPACT_MODE;
		const previousPlugin = Bun.env.OMP_COMPACT_PLUGIN;
		Bun.env.OMP_COMPACT_PLUGIN = "0";
		delete Bun.env.OMP_COMPACT_MODE;
		try {
			const booted = await bootWithTranscript();
			const handler = booted.commandHandlers.get("compact-settings");
			expect(handler).toBeDefined();
			const mount = mountDialog(booted);
			const commandDone = handler?.("", booted.context);
			const dialog = await waitForDialog(mount);
			// The effective snapshot shows the override: Global compact off.
			const rows = dialog.render(120).map((l) => Bun.stripANSI(l));
			expect(
				rows.some((l) => l.includes("Global compact") && l.includes("off")),
			).toBe(true);
			// Ask to re-enable: the save succeeds and persists the requested
			// value, and one notification carries both facts (saved +
			// effective) — the saved value cannot take effect while
			// OMP_COMPACT_PLUGIN=0 is set.
			dialog.handleInput(KEY_SPACE);
			dialog.handleInput("s");
			const saved = await mount.result;
			expect(saved).toMatchObject({ enabled: true });
			await commandDone;
			// Exactly one success-prefixed notification, no separate warning
			// and no generic success pretending the value took effect.
			const successLines = booted.notifications.filter((n) =>
				n.startsWith("omp-compact settings saved"),
			);
			expect(successLines).toHaveLength(1);
			expect(successLines[0]).toBe(
				"omp-compact settings saved; effective enabled remains false because OMP_COMPACT_PLUGIN=0",
			);
			expect(
				booted.notifications.filter((n) => n.includes("OMP_COMPACT_PLUGIN")),
			).toHaveLength(1);
			const persisted = JSON.parse(
				await Bun.file(pluginConfigPath()).text(),
			) as Record<string, unknown>;
			expect(persisted.enabled).toBe(true);
			await shutdown(booted);
		} finally {
			if (previousMode === undefined) delete Bun.env.OMP_COMPACT_MODE;
			else Bun.env.OMP_COMPACT_MODE = previousMode;
			if (previousPlugin === undefined) delete Bun.env.OMP_COMPACT_PLUGIN;
			else Bun.env.OMP_COMPACT_PLUGIN = previousPlugin;
		}
	},
);

// ---------------------------------------------------------------------------
// Legacy env contract (pre-upgrade shipped behavior): OMP_COMPACT_MODE=off
// hard-disables the runtime while the settings command stays registered.
// ---------------------------------------------------------------------------

stockTest("legacy OMP_COMPACT_MODE=off hard-disables the runtime", async () => {
	const previousMode = Bun.env.OMP_COMPACT_MODE;
	const previousPlugin = Bun.env.OMP_COMPACT_PLUGIN;
	Bun.env.OMP_COMPACT_MODE = "off";
	delete Bun.env.OMP_COMPACT_PLUGIN;
	try {
		const booted = await bootWithTranscript();
		// the settings command stays registered regardless
		expect(booted.commands).toContain("compact-settings");
		await beginRun(booted);
		const call = await addTool(
			booted,
			"bash",
			{ command: "printf off" },
			"legacy-off",
		);
		await finishTool(booted, call, {
			toolCallId: "legacy-off",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		// no adapter: no compact rows, no evidence, no timers
		expect(visibleRows(booted.transcript).join("\n")).not.toContain("bash:");
		expect(booted.appendedEntries).toEqual([]);
		expect(booted.intervalCallbacks).toEqual([]);
		await shutdown(booted);
	} finally {
		if (previousMode === undefined) delete Bun.env.OMP_COMPACT_MODE;
		else Bun.env.OMP_COMPACT_MODE = previousMode;
		if (previousPlugin === undefined) delete Bun.env.OMP_COMPACT_PLUGIN;
		else Bun.env.OMP_COMPACT_PLUGIN = previousPlugin;
	}
});
