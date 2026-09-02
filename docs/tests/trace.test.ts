import { afterEach, describe, expect, test } from "bun:test";
import { traceNative } from "../../.omp-plugin/trace";

const original = process.env.OMP_COMPACT_TRACE;

afterEach(() => {
	if (original === undefined) delete process.env.OMP_COMPACT_TRACE;
	else process.env.OMP_COMPACT_TRACE = original;
});

function capture(run: () => void): string[] {
	const lines: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		run();
	} finally {
		console.warn = warn;
	}
	return lines;
}

describe("traceNative", () => {
	test("stays silent and never builds the message when unset", () => {
		delete process.env.OMP_COMPACT_TRACE;
		let built = 0;
		const lines = capture(() => {
			traceNative(() => {
				built++;
				return "should not appear";
			});
		});
		expect(lines).toEqual([]);
		expect(built).toBe(0);
	});

	test("stays silent for the explicit off values", () => {
		for (const value of ["", "0"]) {
			process.env.OMP_COMPACT_TRACE = value;
			const lines = capture(() => {
				traceNative(() => "off");
			});
			expect(lines).toEqual([]);
		}
	});

	test("writes one prefixed line when enabled", () => {
		process.env.OMP_COMPACT_TRACE = "1";
		const lines = capture(() => {
			traceNative(() => "order pairing declined: 1 card vs 2 states");
		});
		expect(lines).toEqual([
			"[omp-compact trace] order pairing declined: 1 card vs 2 states",
		]);
	});
});
