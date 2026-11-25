import { describe, expect, test } from "bun:test";

import { canonicalKeyId, type KeyId } from "@oh-my-pi/pi-coding-agent";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";

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
		// `alt+shift+q`), and the read boundary stores and registers that
		// canonical spelling, so the press the user means fires instead of a
		// plain `alt+q` falling through to the default chord.
		expect(canonicalKeyId("alt+Q")).toBe("alt+shift+q");
		expect(canonicalize("alt+Q")).toBe("alt+shift+q");
		expect(validateDisplayCycleKey("alt+Q")).toBeUndefined();
		expect(isDisplayCycleKey("alt+Q")).toBe(true);
		expect(canonicalKeyId("Alt+C")).toBe("alt+shift+c");
		expect(canonicalize("Alt+C")).toBe("alt+shift+c");
	});

	test("an uppercase base with an explicit shift fires as itself and stays accepted", () => {
		// `alt+shift+D` lowercases to `alt+shift+d`, whose host canonical id
		// equals the canonical id of the intended press — no divergence, so
		// the chord is accepted and fires on exactly the key the user means.
		expect(canonicalKeyId("alt+shift+D")).toBe("alt+shift+d");
		expect(canonicalKeyId("alt+shift+d")).toBe("alt+shift+d");
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
		// `alt+shift+q` — the exact id an `alt+Q` chord must be registered
		// under for the press the user means to fire.
		const pressId = canonicalKeyId(
			decodeKey("\x1bQ", { kitty: false, backspaceIsCtrl: false })?.id ?? "",
		);
		expect(pressId).toBe("alt+shift+q");
		expect(canonicalize("alt+Q")).toBe(pressId);
		// Accepted — the canonicalise-not-reject decision — and usable.
		expect(validateDisplayCycleKey("alt+Q")).toBeUndefined();
		expect(isDisplayCycleKey("alt+Q")).toBe(true);
		// Physical key match: uppercase base keyId matches `shift+alt+q`,
		// whereas plain lowercase `alt+q` does not.
		const lowerId = canonicalKeyId(
			decodeKey("\x1bq", { kitty: false, backspaceIsCtrl: false })?.id ?? "",
		);
		expect(canonicalize("alt+Q").toLowerCase() as KeyId).toBe(pressId as KeyId);
		expect("alt+q").not.toBe(pressId);
		expect(lowerId).toBe("alt+q");
	});

	test("an explicit shift with an uppercase base is never doubled", () => {
		expect(canonicalize("alt+shift+Q")).toBe("alt+shift+q");
		expect(canonicalize("shift+alt+q")).toBe("alt+shift+q");
		expect(canonicalize("alt+shift+D")).toBe("alt+shift+d");
		expect(validateDisplayCycleKey("alt+shift+Q")).toBeUndefined();
	});

	test("esc/return alias to escape/enter like the host", () => {
		expect(canonicalize("alt+esc")).toBe("alt+escape");
		expect(canonicalize("alt+return")).toBe("alt+enter");
		expect(validateDisplayCycleKey("alt+esc")).toBeUndefined();
	});

	test("plus (+) as base key agrees with the host and passes validation", () => {
		expect(canonicalize("ctrl++")).toBe(canonicalKeyId("ctrl++"));
		expect(validateDisplayCycleKey("ctrl++")).toBeUndefined();
		expect(validateDisplayCycleKey("alt++")).toBeUndefined();
		expect(validateDisplayCycleKey("ctrl+alt++")).toBeUndefined();
		expect(isDisplayCycleKey("ctrl++")).toBe(true);
		expect(validateDisplayCycleKey("++")).toBeDefined();
		expect(validateDisplayCycleKey("ctrl+++")).toBeDefined();
	});
});
