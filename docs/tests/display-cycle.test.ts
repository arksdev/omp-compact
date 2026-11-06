import { describe, expect, test } from "bun:test";

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
	validateDisplayCycleKey,
} from "../../.omp-plugin/display-cycle";

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

	test("an explicit shift with an uppercase base is never doubled", () => {
		expect(canonicalize("alt+shift+Q")).toBe("shift+alt+q");
		expect(canonicalize("shift+alt+q")).toBe("shift+alt+q");
		expect(canonicalize("alt+shift+D")).toBe("shift+alt+d");
		expect(validateDisplayCycleKey("alt+shift+Q")).toBeUndefined();
	});

	test("esc/return alias to escape/enter like the host", () => {
		expect(canonicalize("alt+esc")).toBe("alt+escape");
		expect(canonicalize("alt+return")).toBe("alt+enter");
		expect(validateDisplayCycleKey("alt+esc")).toBeUndefined();
	});
});
