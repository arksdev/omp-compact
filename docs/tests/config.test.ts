import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CompactSettings,
	ConfigUpdateError,
	createSettingsStore,
	DEFAULT_SETTINGS,
	MAX_CONFIG_BYTES,
	MAX_THRESHOLD_TOKENS,
	normalizeSettings,
	resolveConfigPath,
	resolveEnvOverrides,
} from "../../.omp-plugin/config";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "omp-compact-config-"));
}

function storeAt(dir: string) {
	const warnings: string[] = [];
	const store = createSettingsStore({
		path: join(dir, "omp-compact", "config.json"),
		warn: (message) => warnings.push(message),
	});
	return { store, warnings };
}

describe("defaults", () => {
	test("empty input normalizes to defaults preserving current behavior", () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
		expect(DEFAULT_SETTINGS.enabled).toBe(true);
		expect(DEFAULT_SETTINGS.mode).toBe("live");
		expect(DEFAULT_SETTINGS.retainGitLive).toBe(true);
		expect(DEFAULT_SETTINGS.autoShake.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.stats.enabled).toBe(true);
		expect(DEFAULT_SETTINGS.autoShake.thresholdTokens).toBe(120_000);
		expect(DEFAULT_SETTINGS.compactVibeRows).toBe(true);
	});

	test("defaults are deeply frozen", () => {
		expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
		expect(Object.isFrozen(DEFAULT_SETTINGS.stats)).toBe(true);
		expect(Object.isFrozen(DEFAULT_SETTINGS.autoShake)).toBe(true);
		expect(Object.isFrozen(DEFAULT_SETTINGS.host)).toBe(true);
	});

	test("normalize rejects unsupported versions with warnings", () => {
		const warnings: string[] = [];
		expect(normalizeSettings({ version: 2 }, (m) => warnings.push(m))).toEqual(
			DEFAULT_SETTINGS,
		);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("normalize validates every field and defaults invalid values", () => {
		const warnings: string[] = [];
		const normalized = normalizeSettings(
			{
				version: 1,
				enabled: "yes",
				mode: "bogus",
				retainGitLive: 1,
				compactPaths: "off",
				stats: { enabled: "x", actions: true, sent: "y" },
				autoShake: { enabled: "on", thresholdTokens: -5 },
				host: { recapEnabled: "no", thinkingBlocksVisible: true },
			},
			(m) => warnings.push(m),
		);
		expect(normalized.enabled).toBe(true);
		expect(normalized.mode).toBe("live");
		expect(normalized.retainGitLive).toBe(true);
		expect(normalized.compactPaths).toBe(true);
		expect(normalized.compactVibeRows).toBe(true);
		expect(normalized.stats).toEqual(DEFAULT_SETTINGS.stats);
		expect(normalized.autoShake.enabled).toBe(false);
		expect(normalized.autoShake.thresholdTokens).toBe(
			DEFAULT_SETTINGS.autoShake.thresholdTokens,
		);
		expect(normalized.host.recapEnabled).toBeUndefined();
		expect(normalized.host.thinkingBlocksVisible).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("a config file without compactVibeRows keeps the compact rows on", () => {
		// Version-1 files written before the toggle existed carry no key at
		// all: the per-field fallback must read as enabled, never as an
		// opt-out, so upgrading never silently restores the stock cards.
		const warnings: string[] = [];
		const normalized = normalizeSettings({ version: 1, mode: "compact" }, (m) =>
			warnings.push(m),
		);
		expect(normalized.compactVibeRows).toBe(true);
		expect(warnings).toEqual([]);
	});

	test("a garbage compactVibeRows defaults on and is named in the diagnostic", () => {
		const warnings: string[] = [];
		const normalized = normalizeSettings(
			{ version: 1, compactVibeRows: "nope", compactPaths: 0 },
			(m) => warnings.push(m),
		);
		expect(normalized.compactVibeRows).toBe(true);
		expect(normalized.compactPaths).toBe(true);
		// The rejected field is reported alongside its peers, in field order.
		expect(warnings).toEqual([
			"invalid config field(s): compactPaths, compactVibeRows; using defaults",
		]);
	});
});

describe("resolveConfigPath", () => {
	const env = {
		OMP_COMPACT_CONFIG: "/home/user/.omp/override.json",
		PI_CODING_AGENT_DIR: "/tmp/agent-dir",
		PI_CONFIG_DIR: ".omp",
		PI_PROFILE: "work",
		HOME: "/home/user",
	};

	test("OMP_COMPACT_CONFIG wins over everything", () => {
		expect(resolveConfigPath(env)).toBe("/home/user/.omp/override.json");
	});

	test("agent dir env is used when no explicit config path", () => {
		expect(
			resolveConfigPath({
				PI_CODING_AGENT_DIR: "/tmp/agent-dir",
				HOME: "/home/user",
			}),
		).toBe("/tmp/agent-dir/omp-compact/config.json");
	});

	test("falls back to home agent directory with PI_CONFIG_DIR override", () => {
		expect(resolveConfigPath({ HOME: "/home/user" })).toBe(
			"/home/user/.omp/agent/omp-compact/config.json",
		);
		expect(
			resolveConfigPath({ HOME: "/home/user", PI_CONFIG_DIR: ".pi" }),
		).toBe("/home/user/.pi/agent/omp-compact/config.json");
	});

	test("active profile redirects the agent directory", () => {
		expect(resolveConfigPath({ HOME: "/home/user", PI_PROFILE: "work" })).toBe(
			"/home/user/.omp/profiles/work/agent/omp-compact/config.json",
		);
	});

	test("empty env falls back to default home layout", () => {
		expect(resolveConfigPath({})).toBe(
			`${process.env.HOME}/.omp/agent/omp-compact/config.json`,
		);
	});

	test("rejects a profile token with a path separator and falls back", () => {
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_PROFILE: "work/../evil",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_PROFILE: "work\\evil",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
	});

	test("rejects a profile token containing .. and falls back", () => {
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_PROFILE: "..",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_PROFILE: "work..prod",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
	});

	test("rejects empty profile token and falls back", () => {
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_PROFILE: "",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
	});

	test("rejects PI_CONFIG_DIR that escapes home and falls back to .omp", () => {
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_CONFIG_DIR: "../etc",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
		expect(
			resolveConfigPath({
				HOME: "/home/user",
				PI_CONFIG_DIR: "/tmp/outside",
			}),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
	});

	test("rejects OMP_COMPACT_CONFIG outside home and project cwd and falls through", () => {
		// Explicit path is highest precedence, but must stay under home or the
		// project cwd. Paths that escape both roots fall through to the next
		// precedence — and emit one warn when a sink is provided.
		const warnings: string[] = [];
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					OMP_COMPACT_CONFIG: "/tmp/evil-config.json",
					PI_CODING_AGENT_DIR: "/tmp/agent-dir",
				},
				{ cwd: "/home/user/project", warn: (m) => warnings.push(m) },
			),
		).toBe("/tmp/agent-dir/omp-compact/config.json");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("OMP_COMPACT_CONFIG");
		expect(warnings[0]).toContain("/tmp/evil-config.json");

		const warnings2: string[] = [];
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					OMP_COMPACT_CONFIG: "/etc/omp-compact.json",
				},
				{ cwd: "/home/user/project", warn: (m) => warnings2.push(m) },
			),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
		expect(warnings2).toHaveLength(1);
	});

	test("accepts OMP_COMPACT_CONFIG under home", () => {
		const warnings: string[] = [];
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					OMP_COMPACT_CONFIG: "/home/user/.omp/custom-config.json",
				},
				{ cwd: "/home/user/project", warn: (m) => warnings.push(m) },
			),
		).toBe("/home/user/.omp/custom-config.json");
		expect(warnings).toEqual([]);
	});

	test("accepts OMP_COMPACT_CONFIG under the project cwd", () => {
		// Per-repo settings and the integration harness temp dir both live
		// under the project root, which is outside $HOME on this workstation.
		// Rejecting them silently is what broke the stock gate at 12e2501.
		const warnings: string[] = [];
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					OMP_COMPACT_CONFIG:
						"/Volumes/Storage2T/Projects/omp-compact/.omp-compact-test/settings.json",
				},
				{
					cwd: "/Volumes/Storage2T/Projects/omp-compact",
					warn: (m) => warnings.push(m),
				},
			),
		).toBe(
			"/Volumes/Storage2T/Projects/omp-compact/.omp-compact-test/settings.json",
		);
		expect(warnings).toEqual([]);

		// Relative project-local form resolves against cwd.
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					OMP_COMPACT_CONFIG: ".omp-compact/config.json",
				},
				{ cwd: "/home/user/project" },
			),
		).toBe("/home/user/project/.omp-compact/config.json");
	});

	test("ordinary no-env path does not warn", () => {
		const warnings: string[] = [];
		expect(
			resolveConfigPath(
				{ HOME: "/home/user" },
				{ cwd: "/home/user/project", warn: (m) => warnings.push(m) },
			),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
		expect(warnings).toEqual([]);
	});

	test("PI_CONFIG_DIR stays home-only even when project cwd is set", () => {
		// A project-local PI_CONFIG_DIR is rejected: that env names the stock
		// agent config root, not a per-project file. Use PI_CODING_AGENT_DIR
		// for project-local agent trees.
		expect(
			resolveConfigPath(
				{
					HOME: "/home/user",
					PI_CONFIG_DIR: "/Volumes/Storage2T/Projects/omp-compact/.config",
				},
				{ cwd: "/Volumes/Storage2T/Projects/omp-compact" },
			),
		).toBe("/home/user/.omp/agent/omp-compact/config.json");
	});
});

describe("store load fail-open", () => {
	test("missing file loads defaults without warning", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		const settings = await store.load();
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});

	test("malformed JSON warns once and falls back to defaults", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			join(dir, "omp-compact", "config.json"),
			"{not json",
			"utf8",
		);
		const first = await store.load();
		const second = await store.load();
		expect(first).toEqual(DEFAULT_SETTINGS);
		expect(second).toEqual(DEFAULT_SETTINGS);
		expect(warnings.filter((w) => w.includes("malformed"))).toHaveLength(1);
		await rm(dir, { recursive: true, force: true });
	});

	test("structural underflow warns and falls back before JSON.parse", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(join(dir, "omp-compact", "config.json"), "}", "utf8");
		expect(await store.load()).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toContain(
			"config JSON closes a structure before opening one; using defaults",
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("oversized JSON warns and falls back to defaults", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const padded = JSON.stringify({
			version: 1,
			enabled: true,
			mode: "live",
			padding: "x".repeat(MAX_CONFIG_BYTES + 1),
		});
		await writeFile(join(dir, "omp-compact", "config.json"), padded, "utf8");
		const settings = await store.load();
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings.some((w) => w.includes("oversized"))).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	test("over-deep JSON warns and falls back to defaults", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		let deep: unknown = { leaf: true };
		for (let i = 0; i < 40; i++) deep = { nested: deep };
		await writeFile(
			join(dir, "omp-compact", "config.json"),
			JSON.stringify(deep),
			"utf8",
		);
		const settings = await store.load();
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings.some((w) => w.includes("depth"))).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	test("valid file with env overrides loads overridden settings", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			join(dir, "omp-compact", "config.json"),
			JSON.stringify({
				version: 1,
				enabled: true,
				mode: "compact",
				retainGitLive: false,
				compactPaths: false,
				stats: { enabled: true, actions: true, sent: false },
				autoShake: { enabled: true, thresholdTokens: 1000 },
				host: { recapEnabled: false },
			}),
			"utf8",
		);
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: {
				OMP_COMPACT_PLUGIN: "0",
				OMP_COMPACT_MODE: "clear",
			},
		});
		const settings = await store.load();
		expect(settings.enabled).toBe(false);
		expect(settings.mode).toBe("clear");
		expect(settings.retainGitLive).toBe(false);
		expect(settings.stats).toEqual({
			enabled: true,
			actions: true,
			sent: false,
			received: true,
			cache: true,
			time: true,
		});
		expect(settings.autoShake.thresholdTokens).toBe(1000);
		expect(settings.host.recapEnabled).toBe(false);
	});

	test("invalid env mode is ignored", async () => {
		const store = createSettingsStore({
			path: join(await tempDir(), "config.json"),
			env: { OMP_COMPACT_MODE: "bogus", OMP_COMPACT_PLUGIN: "1" },
		});
		const settings = await store.load();
		expect(settings.mode).toBe("live");
		expect(settings.enabled).toBe(true);
	});

	test("legacy OMP_COMPACT_MODE=off hard-disables the runtime", async () => {
		const store = createSettingsStore({
			path: join(await tempDir(), "config.json"),
			env: { OMP_COMPACT_MODE: "off" },
		});
		const settings = await store.load();
		expect(settings.enabled).toBe(false);
		expect(settings.mode).toBe("live");
	});

	test("legacy off wins over a persisted enabled=true", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			join(dir, "omp-compact", "config.json"),
			JSON.stringify({ version: 1, enabled: true, mode: "compact" }),
			"utf8",
		);
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: { OMP_COMPACT_MODE: "off" },
		});
		const settings = await store.load();
		expect(settings.enabled).toBe(false);
		expect(settings.mode).toBe("compact");
		await rm(dir, { recursive: true, force: true });
	});

	test("hard env overrides survive a settings save (effective layer only)", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			join(dir, "omp-compact", "config.json"),
			JSON.stringify({ version: 1, enabled: true, mode: "live" }),
			"utf8",
		);
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: { OMP_COMPACT_PLUGIN: "0", OMP_COMPACT_MODE: "clear" },
		});
		await store.load();
		// a menu save asks for enabled=true mode=compact…
		const effective = await store.update({ enabled: true, mode: "compact" });
		// …but the effective snapshot keeps the hard overrides authoritative
		expect(effective.enabled).toBe(false);
		expect(effective.mode).toBe("clear");
		// the persisted file holds exactly the user's requested values
		const raw = JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
		expect(raw.enabled).toBe(true);
		expect(raw.mode).toBe("compact");
		await rm(dir, { recursive: true, force: true });
	});

	test("legacy env off survives a settings save asking to re-enable", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: { OMP_COMPACT_MODE: "off" },
		});
		await store.load();
		const effective = await store.update({ enabled: true, mode: "live" });
		expect(effective.enabled).toBe(false);
		const raw = JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
		expect(raw.enabled).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	test("env mode override keeps its meaning after unrelated saves", async () => {
		const dir = await tempDir();
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: { OMP_COMPACT_MODE: "compact" },
		});
		await store.load();
		const effective = await store.update({ retainGitLive: false });
		expect(effective.mode).toBe("compact");
		expect(effective.retainGitLive).toBe(false);
		const raw = JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
		expect(raw.mode).toBe("live");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("update fails closed on unsafe persisted config", () => {
	test("malformed existing JSON: update rejects and leaves the file byte-for-byte unchanged", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const broken = "{not json";
		await writeFile(file, broken, "utf8");
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(broken);
		await rm(dir, { recursive: true, force: true });
	});

	test("oversized existing JSON: update rejects without replacing it", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const padded = JSON.stringify({
			version: 1,
			enabled: true,
			mode: "live",
			padding: "x".repeat(MAX_CONFIG_BYTES + 1),
		});
		await writeFile(file, padded, "utf8");
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(padded);
		await rm(dir, { recursive: true, force: true });
	});

	test("over-deep existing JSON: update rejects without replacing it", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		let deep: unknown = { leaf: true };
		for (let i = 0; i < 40; i++) deep = { nested: deep };
		const text = JSON.stringify(deep);
		await writeFile(file, text, "utf8");
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(text);
		await rm(dir, { recursive: true, force: true });
	});

	test("valid JSON that fails validation (non-object root): update rejects", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const text = JSON.stringify(["not", "an", "object"]);
		await writeFile(file, text, "utf8");
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(text);
		await rm(dir, { recursive: true, force: true });
	});

	test("valid JSON with an invalid known field: update rejects without replacing it", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const text = JSON.stringify({ version: 1, enabled: "yes", mode: "live" });
		await writeFile(file, text, "utf8");
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(text);
		await rm(dir, { recursive: true, force: true });
	});

	test("deterministic non-ENOENT read failure rejects before persist (injected read seam)", async () => {
		const dir = await tempDir();
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const original = JSON.stringify({
			version: 1,
			enabled: true,
			mode: "live",
		});
		await writeFile(file, original, "utf8");
		const warnings: string[] = [];
		const store = createSettingsStore({
			path: file,
			warn: (message) => warnings.push(message),
			readFile: async (target, encoding) => {
				if (target === file) {
					const error = new Error("simulated EIO") as NodeJS.ErrnoException;
					error.code = "EIO";
					throw error;
				}
				return readFile(target, encoding);
			},
		});
		// Initial load stays fail-open: defaults with a read warning.
		await store.load();
		expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
		expect(warnings.some((w) => w.includes("failed to read config"))).toBe(
			true,
		);
		// The save must fail closed BEFORE persisting anything.
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(original);
		await rm(dir, { recursive: true, force: true });
	});

	test("missing config file: update still succeeds with defaults plus the patch", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		const effective = await store.update({ mode: "compact" });
		expect(effective.mode).toBe("compact");
		const raw = JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
		expect(raw.mode).toBe("compact");
		expect(raw.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(warnings).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});

	test("initial load stays fail-open on malformed JSON; a later update still fails closed", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const broken = '{"version":1, broken';
		await writeFile(file, broken, "utf8");
		const settings = await store.load();
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(broken);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("unknown config keys survive bounded updates (raw-record preservation)", () => {
	test("unknown top-level keys are preserved verbatim through a valid update", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				mode: "live",
				futureFeature: { nested: [1, 2, { deep: true }] },
			}),
			"utf8",
		);
		const updated = await store.update({ mode: "compact" });
		expect(updated.mode).toBe("compact");
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.version).toBe(1);
		expect(raw.mode).toBe("compact");
		expect(raw.futureFeature).toEqual({ nested: [1, 2, { deep: true }] });
		// Unknown keys never leak into the effective settings layer.
		expect(store.snapshot()).toEqual({ ...DEFAULT_SETTINGS, mode: "compact" });
		await rm(dir, { recursive: true, force: true });
	});

	test("unknown keys inside known nested groups survive an update", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				stats: { sent: false, sentUnknown: "keep-me" },
				autoShake: { enabled: false, shakeFuture: { x: 1 } },
				host: { recapEnabled: true, hostFuture: "keep" },
			}),
			"utf8",
		);
		await store.update({ stats: { actions: false } });
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.stats).toEqual({
			sent: false,
			sentUnknown: "keep-me",
			actions: false,
		});
		expect(raw.autoShake).toEqual({ enabled: false, shakeFuture: { x: 1 } });
		expect(raw.host).toEqual({ recapEnabled: true, hostFuture: "keep" });
		await rm(dir, { recursive: true, force: true });
	});

	test("removing a host leaf via undefined keeps unknown host keys", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				host: { recapEnabled: true, futureHostFlag: "keep" },
			}),
			"utf8",
		);
		await store.load();
		await store.update({ host: { recapEnabled: undefined } });
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.host).toEqual({ futureHostFlag: "keep" });
		await rm(dir, { recursive: true, force: true });
	});

	test("concurrent distinct updates preserve unknown keys from the latest file", async () => {
		const dir = await tempDir();
		const a = storeAt(dir);
		const b = storeAt(dir);
		const file = join(dir, "omp-compact", "config.json");
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				mode: "live",
				futureFlag: { on: true },
			}),
			"utf8",
		);
		await a.store.load();
		await b.store.load();
		await Promise.all([
			a.store.update({ enabled: false }),
			b.store.update({ mode: "clear" }),
		]);
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.enabled).toBe(false);
		expect(raw.mode).toBe("clear");
		expect(raw.futureFlag).toEqual({ on: true });
		await rm(dir, { recursive: true, force: true });
	});

	test("an unsupported-version file still fails closed despite unknown keys", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const text = JSON.stringify({ version: 2, mode: "compact", future: 1 });
		await writeFile(file, text, "utf8");
		await expect(store.update({ mode: "clear" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(await readFile(file, "utf8")).toBe(text);
		await rm(dir, { recursive: true, force: true });
	});

	test("an update that would push the merged record past the size limit fails closed", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		// The persisted file sits just under the limit; the patch
		// (thresholdTokens 0 -> 9999999) grows the serialized merged record by
		// 6 bytes plus the write's trailing newline and must be refused by the
		// write-side bound before anything is persisted.
		const base: Record<string, unknown> = {
			version: 1,
			enabled: true,
			mode: "live",
			autoShake: { enabled: false, thresholdTokens: 0 },
		};
		const overhead = JSON.stringify({ ...base, unknown: "" }, null, 2).length;
		const fileText = JSON.stringify(
			{ ...base, unknown: "x".repeat(MAX_CONFIG_BYTES - overhead - 5) },
			null,
			2,
		);
		expect(Buffer.byteLength(fileText, "utf8")).toBe(MAX_CONFIG_BYTES - 5);
		await writeFile(file, fileText, "utf8");
		await store.load();
		await expect(
			store.update({ autoShake: { thresholdTokens: 9_999_999 } }),
		).rejects.toThrow(ConfigUpdateError);
		expect(await readFile(file, "utf8")).toBe(fileText);
		await rm(dir, { recursive: true, force: true });
	});

	test("a version-less persisted file gains version: 1 while keeping unknown keys", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		await writeFile(
			file,
			JSON.stringify({ enabled: false, futureKey: "keep" }),
			"utf8",
		);
		await store.update({ mode: "compact" });
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.version).toBe(1);
		expect(raw.futureKey).toBe("keep");
		expect(raw.enabled).toBe(false);
		expect(raw.mode).toBe("compact");
		await rm(dir, { recursive: true, force: true });
	});

	test("an existing version: 1 is preserved unchanged through an update", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		await writeFile(
			file,
			JSON.stringify({ version: 1, enabled: false, futureKey: "keep" }),
			"utf8",
		);
		await store.update({ mode: "compact" });
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.version).toBe(1);
		expect(raw.futureKey).toBe("keep");
		expect(raw.enabled).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	test("deep unknown payload at the depth limit survives and stays bounded", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		// Root object (depth 1) plus 14 wrappers plus the leaf object =
		// MAX_CONFIG_DEPTH: the update must accept the file and write a result
		// that still parses under the bounded contract (no write-side false
		// positive).
		let nested: unknown = { leaf: true };
		for (let i = 0; i < 14; i++) nested = { child: nested };
		const record = { version: 1, mode: "live", unknown: nested };
		await writeFile(file, JSON.stringify(record), "utf8");
		await store.load();
		const updated = await store.update({ mode: "clear" });
		expect(updated.mode).toBe("clear");
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<
			string,
			unknown
		>;
		expect(raw.mode).toBe("clear");
		expect(raw.unknown).toEqual(nested);
		const text = await readFile(file, "utf8");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
			MAX_CONFIG_BYTES,
		);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("env overrides report", () => {
	test("clean env reports no overrides", () => {
		expect(resolveEnvOverrides({})).toEqual({
			enabledBy: [],
			modeBy: undefined,
		});
	});

	test("OMP_COMPACT_PLUGIN=0 and false force enabled", () => {
		expect(resolveEnvOverrides({ OMP_COMPACT_PLUGIN: "0" }).enabledBy).toEqual([
			"OMP_COMPACT_PLUGIN",
		]);
		expect(
			resolveEnvOverrides({ OMP_COMPACT_PLUGIN: "false" }).enabledBy,
		).toEqual(["OMP_COMPACT_PLUGIN"]);
	});

	test("legacy OMP_COMPACT_MODE=off forces enabled and names that variable", () => {
		const overrides = resolveEnvOverrides({ OMP_COMPACT_MODE: "off" });
		expect(overrides.enabledBy).toEqual(["OMP_COMPACT_MODE"]);
		expect(overrides.modeBy).toBeUndefined();
	});

	test("both disable switches list both variables", () => {
		const overrides = resolveEnvOverrides({
			OMP_COMPACT_PLUGIN: "0",
			OMP_COMPACT_MODE: "off",
		});
		expect(overrides.enabledBy).toEqual([
			"OMP_COMPACT_PLUGIN",
			"OMP_COMPACT_MODE",
		]);
	});

	test("a valid OMP_COMPACT_MODE forces mode; anything else does not", () => {
		expect(resolveEnvOverrides({ OMP_COMPACT_MODE: "compact" }).modeBy).toBe(
			"OMP_COMPACT_MODE",
		);
		expect(resolveEnvOverrides({ OMP_COMPACT_MODE: "bogus" }).modeBy).toBe(
			undefined,
		);
	});

	test("store.overrides() mirrors the env the store was created with", async () => {
		const dir = await tempDir();
		const store = createSettingsStore({
			path: join(dir, "omp-compact", "config.json"),
			env: { OMP_COMPACT_PLUGIN: "0", OMP_COMPACT_MODE: "clear" },
		});
		expect(store.overrides?.()).toEqual({
			enabledBy: ["OMP_COMPACT_PLUGIN"],
			modeBy: "OMP_COMPACT_MODE",
		});
		await rm(dir, { recursive: true, force: true });
	});
});

describe("persistence is atomic", () => {
	test("update writes a valid file and leaves no temp files", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		const updated = await store.update({ mode: "clear", retainGitLive: false });
		expect(updated.mode).toBe("clear");
		const raw = await readFile(join(dir, "omp-compact", "config.json"), "utf8");
		const parsed = JSON.parse(raw) as CompactSettings;
		expect(parsed.mode).toBe("clear");
		expect(parsed.retainGitLive).toBe(false);
		const files = await readdir(join(dir, "omp-compact"));
		expect(files.filter((f) => f.includes("tmp"))).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});

	test("failed persist keeps state, notifies nobody, cleans temp", async () => {
		const dir = await tempDir();
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "i am a file, not a directory", "utf8");
		const store = createSettingsStore({
			path: join(blocker, "config.json"),
			warn: () => {},
		});
		await store.load();
		let notified = 0;
		store.subscribe(() => notified++);
		await expect(store.update({ mode: "compact" })).rejects.toThrow();
		expect(notified).toBe(0);
		expect(store.snapshot().mode).toBe("live");
		await rm(dir, { recursive: true, force: true });
	});

	test("update rejects invalid patches without persisting", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await expect(store.update({ mode: "bogus" as never })).rejects.toThrow();
		await expect(
			store.update({ autoShake: { thresholdTokens: -1 } }),
		).rejects.toThrow();
		await expect(
			store.update({
				autoShake: { thresholdTokens: MAX_THRESHOLD_TOKENS + 1 },
			}),
		).rejects.toThrow();
		const files = await readdir(join(dir, "omp-compact")).catch(() => []);
		expect(files).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("concurrent stores (E02 leaf-field merge)", () => {
	/** Two stores over the same config file, both loaded before any write. */
	async function twoStores(dir: string) {
		const a = storeAt(dir);
		const b = storeAt(dir);
		await a.store.load();
		await b.store.load();
		return { a, b };
	}

	async function readStored(dir: string): Promise<CompactSettings> {
		return JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
	}

	test("disjoint top-level edits from stale snapshots compose", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ enabled: false });
		// b still holds the snapshot from before a's write.
		const effective = await b.store.update({ mode: "clear" });
		// b's reread absorbed a's edit instead of overwriting it…
		expect(effective.enabled).toBe(false);
		expect(effective.mode).toBe("clear");
		const raw = await readStored(dir);
		expect(raw.enabled).toBe(false);
		expect(raw.mode).toBe("clear");
		expect(raw.retainGitLive).toBe(DEFAULT_SETTINGS.retainGitLive);
		await rm(dir, { recursive: true, force: true });
	});

	test("simultaneous disjoint writers compose through the path queue", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await Promise.all([
			a.store.update({ enabled: false, stats: { sent: false } }),
			b.store.update({ mode: "clear", autoShake: { enabled: true } }),
		]);
		const raw = await readStored(dir);
		expect(raw.enabled).toBe(false);
		expect(raw.mode).toBe("clear");
		expect(raw.stats.sent).toBe(false);
		expect(raw.autoShake.enabled).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	test("a compactVibeRows opt-out persists and composes with a stale peer edit", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		const effective = await a.store.update({ compactVibeRows: false });
		expect(effective.compactVibeRows).toBe(false);
		// b's snapshot predates a's write and says compactVibeRows=true; its
		// own disjoint edit must not re-assert the default over a's opt-out.
		await b.store.update({ compactPaths: false });
		const raw = await readStored(dir);
		expect(raw.compactVibeRows).toBe(false);
		expect(raw.compactPaths).toBe(false);
		expect(raw.retainGitLive).toBe(DEFAULT_SETTINGS.retainGitLive);
		await rm(dir, { recursive: true, force: true });
	});

	test("disjoint nested edits compose within and across groups", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ stats: { sent: false } });
		// b's snapshot still says sent=true, so its save must not re-assert it.
		await b.store.update({
			stats: { time: false },
			autoShake: { enabled: true },
		});
		const raw = await readStored(dir);
		expect(raw.stats.sent).toBe(false);
		expect(raw.stats.time).toBe(false);
		// leaves neither writer touched stay at their persisted values
		expect(raw.stats.actions).toBe(DEFAULT_SETTINGS.stats.actions);
		expect(raw.stats.cache).toBe(DEFAULT_SETTINGS.stats.cache);
		expect(raw.autoShake.enabled).toBe(true);
		expect(raw.autoShake.thresholdTokens).toBe(
			DEFAULT_SETTINGS.autoShake.thresholdTokens,
		);
		expect(raw.host).toEqual(DEFAULT_SETTINGS.host);
		await rm(dir, { recursive: true, force: true });
	});

	test("host leaves merge independently", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ host: { recapEnabled: false } });
		await b.store.update({ host: { thinkingBlocksVisible: false } });
		const raw = await readStored(dir);
		expect(raw.host).toEqual({
			recapEnabled: false,
			thinkingBlocksVisible: false,
		});
		await rm(dir, { recursive: true, force: true });
	});

	test("same-field conflict: deterministic last successful writer wins", async () => {
		// The policy is documented by the test order: the store whose atomic
		// rename lands last determines the value — never a merge of two
		// conflicting values and never a first-writer lock.
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ mode: "compact" });
		await b.store.update({ mode: "clear" });
		expect((await readStored(dir)).mode).toBe("clear");
		await rm(dir, { recursive: true, force: true });

		// The reverse order on a fresh pair wins the other way.
		const reverse = await tempDir();
		const first = storeAt(reverse);
		const second = storeAt(reverse);
		await first.store.load();
		await second.store.load();
		await first.store.update({ mode: "clear" });
		await second.store.update({ mode: "compact" });
		expect((await readStored(reverse)).mode).toBe("compact");
		await rm(reverse, { recursive: true, force: true });
	});

	test("nested same-field conflict follows the same last-writer policy", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ autoShake: { thresholdTokens: 1000 } });
		// b's stale snapshot still has the 120000 default, so this save is a
		// real writer of the same leaf a just wrote; its rename lands last and wins.
		await b.store.update({ autoShake: { thresholdTokens: 500 } });
		expect((await readStored(dir)).autoShake.thresholdTokens).toBe(500);
		await rm(dir, { recursive: true, force: true });
	});

	test("invalid latest file: the save fails closed and leaves the file byte-identical", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await store.load();
		// Another writer left a corrupt file after our snapshot.
		await mkdir(join(dir, "omp-compact"), { recursive: true });
		const file = join(dir, "omp-compact", "config.json");
		const broken = "{broken";
		await writeFile(file, broken, "utf8");
		let notified = 0;
		store.subscribe(() => notified++);
		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		// The malformed payload is diagnosed, but never adopted or rewritten.
		expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
		expect(notified).toBe(0);
		expect(store.snapshot().mode).toBe("live");
		expect(await readFile(file, "utf8")).toBe(broken);
		await rm(dir, { recursive: true, force: true });
	});

	test("missing latest file fails open silently and recreates from defaults", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await store.update({ stats: { sent: false } });
		// The file disappears between our snapshot and the save.
		await rm(join(dir, "omp-compact", "config.json"));
		const effective = await store.update({ mode: "clear" });
		expect(effective.mode).toBe("clear");
		// Missing file is silent on load, and the update is not a retry loop.
		expect(warnings).toEqual([]);
		const raw = await readStored(dir);
		expect(raw.mode).toBe("clear");
		expect(raw.stats.sent).toBe(DEFAULT_SETTINGS.stats.sent);
		await rm(dir, { recursive: true, force: true });
	});

	test("failed write leaves the other store's JSON byte-identical and this store silent", async () => {
		const dir = await tempDir();
		const { a, b } = await twoStores(dir);
		await a.store.update({ enabled: false });
		const configDir = join(dir, "omp-compact");
		const before = await readFile(join(configDir, "config.json"), "utf8");
		// Make the config dir read-only so b's tmp write fails mid-flight.
		await chmod(configDir, 0o500);
		let notified = 0;
		b.store.subscribe(() => notified++);
		await expect(b.store.update({ mode: "clear" })).rejects.toThrow();
		await chmod(configDir, 0o700);
		// No false success: no notification, no adopted state.
		expect(notified).toBe(0);
		expect(b.store.snapshot().mode).toBe("live");
		// a's persisted JSON is untouched by the failed concurrent write.
		expect(await readFile(join(configDir, "config.json"), "utf8")).toBe(before);
		expect(JSON.parse(before) as CompactSettings).toMatchObject({
			enabled: false,
			mode: "live",
		});
		await rm(dir, { recursive: true, force: true });
	});
});

describe("snapshots are immutable", () => {
	test("snapshot is deeply frozen and isolated from later updates", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		const before = store.snapshot();
		expect(Object.isFrozen(before)).toBe(true);
		expect(Object.isFrozen(before.stats)).toBe(true);
		await store.update({ mode: "compact" });
		const after = store.snapshot();
		expect(before.mode).toBe("live");
		expect(after.mode).toBe("compact");
		expect(before).not.toBe(after);
		await rm(dir, { recursive: true, force: true });
	});

	test("snapshot returns the stable frozen current without cloning", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		const first = store.snapshot();
		const second = store.snapshot();
		// current is replaced (never mutated) and deep-frozen at construction,
		// so snapshot can share identity instead of clone-and-freeze per call.
		expect(first).toBe(second);
		expect(first.stats).toBe(second.stats);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.stats)).toBe(true);
		expect(Object.isFrozen(first.autoShake)).toBe(true);
		expect(Object.isFrozen(first.host)).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("subscribers", () => {
	test("subscribers are notified with the new snapshot once persistence succeeded", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		let calls = 0;
		let seen: CompactSettings | undefined;
		store.subscribe((settings) => {
			calls++;
			seen = settings;
		});
		const updated = await store.update({ retainGitLive: false });
		expect(calls).toBe(1);
		expect(seen).toBe(updated);
		expect(seen?.retainGitLive).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	test("unsubscribe stops notifications", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		let calls = 0;
		const unsubscribe = store.subscribe(() => calls++);
		unsubscribe();
		await store.update({ mode: "clear" });
		expect(calls).toBe(0);
		await rm(dir, { recursive: true, force: true });
	});

	test("load does not notify subscribers", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		let calls = 0;
		store.subscribe(() => calls++);
		await store.load();
		expect(calls).toBe(0);
		await rm(dir, { recursive: true, force: true });
	});

	test("throwing subscriber does not reject a committed update", async () => {
		const dir = await tempDir();
		const { store, warnings } = storeAt(dir);
		await store.load();

		const seen: CompactSettings[] = [];
		store.subscribe(() => {
			throw new Error("subscriber boom");
		});
		store.subscribe((settings) => {
			seen.push(settings);
		});

		const updated = await store.update({ mode: "compact" });
		expect(updated.mode).toBe("compact");
		expect(store.snapshot()).toBe(updated);
		expect(store.snapshot().mode).toBe("compact");
		expect(seen).toEqual([updated]);

		const raw = JSON.parse(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		) as CompactSettings;
		expect(raw.mode).toBe("compact");
		expect(warnings.some((w) => w.includes("subscriber"))).toBe(true);

		// One warning per failure class for the life of the store, not per call.
		await store.update({ mode: "clear" });
		expect(warnings.filter((w) => w.includes("subscriber")).length).toBe(1);

		await rm(dir, { recursive: true, force: true });
	});

	test("validation failure still rejects without writing or notifying", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		const before = store.snapshot();

		let notified = 0;
		store.subscribe(() => {
			notified++;
			throw new Error("must not run");
		});

		await expect(store.update({ mode: "bogus" as never })).rejects.toThrow();
		expect(notified).toBe(0);
		expect(store.snapshot()).toBe(before);
		expect(store.snapshot().mode).toBe(before.mode);

		// No config file written on pure validation failure before first save.
		await expect(
			readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		).rejects.toThrow();

		await rm(dir, { recursive: true, force: true });
	});

	test("bounded-JSON contract breach still rejects after a prior save", async () => {
		const dir = await tempDir();
		const { store } = storeAt(dir);
		await store.load();
		await store.update({ mode: "live" });
		const beforeText = await readFile(
			join(dir, "omp-compact", "config.json"),
			"utf8",
		);
		const before = store.snapshot();

		let notified = 0;
		store.subscribe(() => {
			notified++;
		});

		// Oversized unknown key would push the merged record past the byte budget
		// if it were accepted; force via a patch that is valid at normalize but
		// is not the path under test. Use ConfigUpdateError path: oversized file
		// already present fails closed on reread.
		const padded = `${"x".repeat(MAX_CONFIG_BYTES + 1)}`;
		const oversized = `${JSON.stringify(
			{ version: 1, mode: "live", junk: padded },
			null,
			2,
		)}\n`;
		await writeFile(join(dir, "omp-compact", "config.json"), oversized, "utf8");

		await expect(store.update({ mode: "compact" })).rejects.toThrow(
			ConfigUpdateError,
		);
		expect(notified).toBe(0);
		expect(store.snapshot()).toBe(before);
		expect(
			await readFile(join(dir, "omp-compact", "config.json"), "utf8"),
		).toBe(oversized);
		// Sanity: prior committed text is not what we assert equality against after
		// the oversized rewrite — file stays the oversized payload (not rewritten).
		expect(beforeText).not.toBe(oversized);

		await rm(dir, { recursive: true, force: true });
	});
});
