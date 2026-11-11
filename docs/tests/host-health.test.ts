/**
 * Whether the installed omp still provides everything the plugin reaches
 * outside omp's public entry points.
 *
 * `host-modules.ts` loads those helpers optionally, so a host that moved one
 * keeps the plugin running with one feature off. Users get a warning; this
 * suite turns the same condition into a failure, so the daily drift job
 * (`.github/workflows/host-drift.yml`, which swaps in the newest published
 * omp) reports it before a user does. Each failure names the disabled
 * feature, the specifier and the export.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	type DisabledComponent,
	disabledComponents,
} from "../../.omp-plugin/host-modules";
import {
	beginRun,
	boot,
	rows,
	runTool,
	stockDescribe,
} from "./integration-kit";
import { cleanupStockSettings } from "./test-stock-host";

afterAll(() => {
	cleanupStockSettings();
});

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_ENTRY = join(REPO_ROOT, ".omp-plugin", "index.ts");
const RPC_TIMEOUT_MS = 60_000;

function describeDisabled(entries: readonly DisabledComponent[]): string {
	return entries
		.map(
			(entry) =>
				`${entry.component}: ${entry.symbol} from ${entry.specifier} (${entry.reason})`,
		)
		.join("\n");
}

test("every host helper the plugin imports loads from the installed omp", () => {
	// Joined text, not an array assert: Bun truncates long array diffs, and
	// the names are the whole point of the failure.
	const disabled = disabledComponents();
	if (disabled.length > 0)
		throw new Error(
			`omp-compact components disabled on this omp:\n${describeDisabled(disabled)}`,
		);
});

interface RpcRun {
	readonly frames: readonly Record<string, unknown>[];
	/** stdout lines that were not protocol frames, plus stderr. */
	readonly noise: string;
}

/**
 * Start the real omp from `OMP_STOCK_BIN` in RPC mode with only this plugin,
 * ask it for its commands, then close stdin and collect every frame it wrote
 * until it exits. HOME and the XDG dirs point at a temp dir, so the run
 * neither reads nor writes the user's omp state.
 */
async function runPluginInOmp(): Promise<RpcRun> {
	const binary = resolve(REPO_ROOT, process.env.OMP_STOCK_BIN ?? "");
	const home = mkdtempSync(join(tmpdir(), "omp-compact-health-"));
	try {
		const child = Bun.spawn(
			[
				binary,
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-context-files",
				"--no-lsp",
				"-e",
				PLUGIN_ENTRY,
			],
			{
				cwd: home,
				env: {
					...process.env,
					HOME: home,
					XDG_CONFIG_HOME: join(home, ".config"),
					XDG_DATA_HOME: join(home, ".local", "share"),
					XDG_STATE_HOME: join(home, ".local", "state"),
					XDG_CACHE_HOME: join(home, ".cache"),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				// A hung startup must end the run, not the suite's timeout.
				timeout: RPC_TIMEOUT_MS,
			},
		);
		try {
			const stderr = new Response(child.stderr).text();
			const frames: Record<string, unknown>[] = [];
			const stray: string[] = [];
			child.stdin.write(
				`${JSON.stringify({ type: "get_available_commands", id: "health" })}\n`,
			);
			child.stdin.flush();
			let buffered = "";
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline !== -1) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!line) continue;
					let frame: Record<string, unknown>;
					try {
						frame = JSON.parse(line) as Record<string, unknown>;
					} catch {
						// A newer omp printing outside the protocol is reported with
						// the failure, not thrown from the reader.
						stray.push(line);
						continue;
					}
					frames.push(frame);
					// The answer means startup finished: closing stdin ends the
					// run, and omp flushes whatever its session start produced.
					if (frame.type === "response" && frame.id === "health")
						child.stdin.end();
				}
			}
			await child.exited;
			return { frames, noise: [...stray, await stderr].join("\n") };
		} finally {
			// No-op after a clean exit; ends a child the reader gave up on.
			child.kill();
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

stockDescribe("the plugin inside the installed omp", () => {
	test("omp loads the plugin, registers its commands and reports nothing disabled", async () => {
		const { frames, noise } = await runPluginInOmp();
		const response = frames.find(
			(frame) => frame.type === "response" && frame.id === "health",
		);
		expect(response, `no RPC answer; omp output:\n${noise}`).toBeDefined();
		const data = response?.data as
			| { commands?: readonly { name?: unknown }[] }
			| undefined;
		const commands = (data?.commands ?? []).map((command) => command.name);
		expect(commands).toContain("compact-settings");
		const extensionErrors = frames.filter(
			(frame) => frame.type === "extension_error",
		);
		expect(extensionErrors).toEqual([]);
		const warnings = frames
			.filter(
				(frame) =>
					frame.type === "extension_ui_request" &&
					frame.method === "notify" &&
					String(frame.message).startsWith("omp-compact:"),
			)
			.map((frame) => String(frame.message));
		expect(warnings).toEqual([]);
	});

	test("the presenter omp registers draws the plugin's compact row", async () => {
		const booted = await boot("compact");
		expect(booted.commands).toContain("compact-settings");
		await beginRun(booted);
		await runTool(booted, "call-1", "grep", { pattern: "first" });
		expect(rows(booted)).toBe("• grep: first");
		expect(
			booted.notifications.filter((message) =>
				message.includes("features are off"),
			),
		).toEqual([]);
	});
});
