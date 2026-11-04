import { describe, expect, test } from "bun:test";

import { RowsNodes } from "../../.omp-plugin/native-describe";
import { fixedForeground } from "../../.omp-plugin/render";

describe("compact rows in Tern's native view", () => {
	test("fixed plugin colours keep their meaning as theme tokens", () => {
		// Tern spans carry theme tokens only: a raw hex would be dropped.
		const line = `write: b.txt ${fixedForeground("#A4D734", "+1")}|${fixedForeground("#A1471A", "-2")}`;
		expect(new RowsNodes().node({}, [line], 80)).toEqual({
			k: "text",
			p: {
				wrap: "none",
				spans: [
					{ t: "write: b.txt " },
					{ t: "+1", s: "success" },
					{ t: "|" },
					{ t: "-2", s: "error" },
				],
			},
		});
	});
});
