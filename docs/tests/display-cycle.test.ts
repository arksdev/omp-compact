import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	addKeyAliases,
	canonicalKeyId,
	parseKey,
	type KeyId,
} from "@oh-my-pi/pi-tui";

import {
	canonicalize,
	DEFAULT_DISPLAY_CYCLE_KEY,
	isDisplayCycleKey,
	RESERVED_SHORTCUTS,
	validateDisplayCycleKey,
} from "../../.omp-plugin/display-cycle";

const REPO_ROOT = resolve(import.meta.dir, "../..");

describe("display cycle: canonical chord agreement with the host", () => {
	test("an uppercase base key is accepted and canonicalised rather than refused", () => {
		// Canonicalise, not reject: the host reads an uppercase ASCII base
		// without an explicit shift as a shifted key (`alt+Q` →
		// `shift+alt+q`), and the read boundary stores and registers that
		// canonical spelling, so the press the user means fires instead of a
		// plain `alt+q` falling through to the default chord.
		expect(canonicalKeyId("alt+Q")).toBe("shift+alt+q");
		expect(canonicalize("alt+Q")).toBe("shift+alt+q");
		expect(validateDisplayCycleKey("alt+Q")).toBeUndefined();
		expect(isDisplayCycleKey("alt+Q")).toBe(true);
		expect(canonicalKeyId("Alt+C")).toBe("shift+alt+c");
		expect(canonicalize("Alt+C")).toBe("shift+alt+c");
		expect(validateDisplayCycleKey("Alt+C")).toBe(
			"Alt+C is already taken by OMP; pick another shortcut",
		);
	});

	test("an uppercase base with an explicit shift fires as itself and stays accepted", () => {
		// `alt+shift+D` lowercases to `alt+shift+d`, whose host canonical id
		// equals the canonical id of the intended press — no divergence, so
		// the chord is accepted and fires on exactly the key the user means.
		expect(canonicalKeyId("alt+shift+D")).toBe("shift+alt+d");
		expect(canonicalKeyId("alt+shift+d")).toBe("shift+alt+d");
		expect(validateDisplayCycleKey("alt+shift+D")).toBeUndefined();
		expect(isDisplayCycleKey("alt+shift+D")).toBe(true);
	});

	test("the default chord stays accepted and canonical-stable", () => {
		expect(canonicalKeyId(DEFAULT_DISPLAY_CYCLE_KEY)).toBe("alt+c");
		expect(validateDisplayCycleKey(DEFAULT_DISPLAY_CYCLE_KEY)).toBeUndefined();
	});
});

describe("display cycle: canonical spelling is the host's press identity", () => {
	test("canonicalize agrees with the host's canonicalKeyId for every chord shape", () => {
		// The host derives the id a physical keypress matches against with
		// canonicalKeyId (@oh-my-pi/pi-tui keybindings.ts). The plugin's
		// canonicalize is the mirror of that function, so every spelling a
		// user can enter must map to the same id in both: uppercase bases
		// (with and without an explicit shift), esc/return aliases, modifier
		// case and ordering, special keys, function keys, symbols and a
		// non-ASCII uppercase base (deliberately NOT shift — the host's
		// uppercase test is ASCII-only).
		const chords = [
			"alt+Q",
			"ALT+Q",
			"alt+q",
			"Alt+C",
			"SHIFT+ALT+D",
			"alt+shift+D",
			"alt+shift+Q",
			"esc",
			"alt+esc",
			"alt+return",
			"ctrl+alt+enter",
			"alt+Escape",
			"super+alt+d",
			"alt+space",
			"ctrl+shift+o",
			"alt+up",
			"alt+F5",
			"alt+1",
			"ctrl+]",
			"alt+А",
			"shift+alt+v",
			"ctrl+P",
			"alt+shift+c",
			"alt+shift+d",
		];
		for (const chord of chords) {
			expect(canonicalize(chord), chord).toBe(canonicalKeyId(chord));
		}
	});

	test("alt+Q canonicalises to and registers the id the keypress derives", () => {
		// Physical alt+Q press: the terminal sends ESC followed by "Q"; the
		// host parses that to `alt+shift+q` and canonicalizes it to
		// `shift+alt+q` — the exact id an `alt+Q` chord must be registered
		// under for the press the user means to fire.
		const pressId = canonicalKeyId(parseKey("\x1bQ") ?? "");
		expect(pressId).toBe("shift+alt+q");
		expect(canonicalize("alt+Q")).toBe(pressId);
		// Accepted — the canonicalise-not-reject decision — and usable.
		expect(validateDisplayCycleKey("alt+Q")).toBeUndefined();
		expect(isDisplayCycleKey("alt+Q")).toBe(true);
		// Host side: getShortcuts() lowercases the registered chord, then
		// CustomEditor probes the press through
		// addKeyAliases(canonicalKeyId(chord)). The canonical chord turns
		// into exactly the press id; the plain lowercase chord (what the old
		// verbatim registration produced) does not.
		const canonicalMatch = new Set<string>();
		addKeyAliases(canonicalMatch, canonicalize("alt+Q").toLowerCase() as KeyId);
		expect(canonicalMatch.has(pressId)).toBe(true);
		const lowercaseMatch = new Set<string>();
		addKeyAliases(lowercaseMatch, "alt+q");
		expect(lowercaseMatch.has(pressId)).toBe(false);
		expect(lowercaseMatch.has(canonicalKeyId(parseKey("\x1bq") ?? ""))).toBe(
			true,
		);
	});

	test("an uppercase chord that collides with a reserved chord is caught", () => {
		// `ctrl+P` reads as `ctrl+shift+p` to the host — the reserved
		// `shift+ctrl+p` built-in. The occupancy check must compare the
		// canonical spelling, or the chord would be accepted, register as
		// `ctrl+p` after the host lowercases it, and fire on a different key
		// than the user meant.
		expect(canonicalKeyId("ctrl+P")).toBe("ctrl+shift+p");
		expect(validateDisplayCycleKey("ctrl+P")).toBe(
			"ctrl+P is already taken by OMP; pick another shortcut",
		);
	});

	test("an explicit shift with an uppercase base is never doubled", () => {
		expect(canonicalize("alt+shift+Q")).toBe("shift+alt+q");
		expect(canonicalize("shift+alt+q")).toBe("shift+alt+q");
		expect(canonicalize("alt+shift+D")).toBe("shift+alt+d");
		expect(validateDisplayCycleKey("alt+shift+Q")).toBeUndefined();
	});

	test("esc/return alias to escape/enter and collide like the host", () => {
		expect(canonicalize("alt+esc")).toBe("alt+escape");
		expect(canonicalize("alt+return")).toBe("alt+enter");
		// `alt+return` is the reserved `alt+enter` chord once canonicalized;
		// validation must refuse it rather than register a chord that
		// collides after the host rewrites it.
		expect(validateDisplayCycleKey("alt+return")).toBe(
			"alt+return is already taken by OMP; pick another shortcut",
		);
		expect(validateDisplayCycleKey("alt+esc")).toBeUndefined();
	});
});

describe("display cycle: reserved-shortcut copy against the host", () => {
	test("the copy matches the host's private reserved set", () => {
		// Derive the expected set from the actual pinned host source instead
		// of a literal: #RESERVED_SHORTCUTS is a private static class member
		// (unreadable at runtime), and a bump of the pinned agent adds a
		// reserved chord without any edit in this repo. The plugin copy is
		// the only thing standing between a user and a silently dead key, so
		// divergence between the copy and the host must fail loudly here.
		const source = readFileSync(
			resolve(
				REPO_ROOT,
				"node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts",
			),
			"utf8",
		);
		const block =
			/static readonly #RESERVED_SHORTCUTS: Record<string, true> = \{([\s\S]*?)\n\t\};/.exec(
				source,
			);
		expect(block).not.toBeNull();
		const hostKeys = new Set(
			[
				...(block?.[1] ?? "").matchAll(/^\t+(?:"([^"]+)"|([a-z.]+)): true,$/gm),
			].map(
				// Each matching line has exactly one of the two alternatives.
				(match) => (match[1] ?? match[2]) as string,
			),
		);
		expect(hostKeys.size).toBeGreaterThan(0);
		expect(new Set(RESERVED_SHORTCUTS)).toEqual(hostKeys);
	});
});
