import { describe, expect, test } from "bun:test";

import { DescriptorPatch } from "../../.omp-plugin/patch-kit";

class Target {
	readonly marker = "instance";

	a(value: string): string {
		return `a:${value}:${this.marker}`;
	}

	b(value: string): string {
		return `b:${value}`;
	}

	c(value: string): string {
		return `c:${value}`;
	}
}

function wrapper(prefix: string): PropertyDescriptor {
	return {
		configurable: true,
		writable: true,
		value(...args: unknown[]): unknown {
			return `${prefix}:${String(args[0])}`;
		},
	};
}

describe("DescriptorPatch", () => {
	test("installs wrappers and routes calls to them", () => {
		const target = new Target();
		const patch = new DescriptorPatch(target, ["a", "b"]);
		patch.install({
			a: wrapper("wrapped-a"),
			b: wrapper("wrapped-b"),
		});
		expect(patch.installed).toBe(true);
		expect(target.a("x")).toBe("wrapped-a:x");
		expect(target.b("y")).toBe("wrapped-b:y");
		expect(Object.hasOwn(target, "a")).toBe(true);
		expect(Object.hasOwn(target, "b")).toBe(true);
	});

	test("restore reinstates exact own descriptors and removes wrappers over inherited methods", () => {
		const accessor = {
			_value: 1,
			get x(): number {
				return this._value;
			},
			set x(value: number) {
				this._value = value;
			},
		};
		const originalDescriptor = Object.getOwnPropertyDescriptor(accessor, "x");
		expect(originalDescriptor).toBeDefined();
		if (!originalDescriptor) throw new Error("accessor descriptor missing");
		const patch = new DescriptorPatch(accessor, ["x"]);
		patch.install({ x: { configurable: true, writable: true, value: 42 } });
		expect(accessor.x).toBe(42);
		patch.restore();
		expect(Object.getOwnPropertyDescriptor(accessor, "x")).toEqual(
			originalDescriptor,
		);
		expect(accessor.x).toBe(1);

		const target = new Target();
		const originalA = target.a;
		const inheritedPatch = new DescriptorPatch(target, ["a"]);
		inheritedPatch.install({ a: wrapper("wrapped-a") });
		inheritedPatch.restore();
		expect(Object.hasOwn(target, "a")).toBe(false);
		expect(target.a).toBe(originalA);
		expect(target.a("x")).toBe("a:x:instance");
		expect(inheritedPatch.installed).toBe(false);
	});

	test("restore is idempotent and exactly-once", () => {
		const target = new Target();
		const originalA = target.a;
		const patch = new DescriptorPatch(target, ["a"]);
		patch.install({ a: wrapper("wrapped-a") });
		patch.restore();
		patch.restore();
		expect(target.a).toBe(originalA);
		expect(Object.hasOwn(target, "a")).toBe(false);
	});

	test("mid-install failure restores already-installed wrappers and rethrows", () => {
		const target = new Target();
		const originalA = target.a;
		Object.defineProperty(target, "b", {
			value: target.b,
			configurable: false,
			writable: true,
		});
		const originalB = target.b;
		const patch = new DescriptorPatch(target, ["a", "b", "c"]);
		expect(() =>
			patch.install({
				a: wrapper("wrapped-a"),
				b: wrapper("wrapped-b"),
				c: wrapper("wrapped-c"),
			}),
		).toThrow(TypeError);
		// wrappers applied before the failing property are gone
		expect(Object.hasOwn(target, "a")).toBe(false);
		expect(target.a).toBe(originalA);
		// the failing property and everything after stay untouched
		expect(target.b).toBe(originalB);
		expect(Object.getOwnPropertyDescriptor(target, "b")?.configurable).toBe(
			false,
		);
		expect(Object.hasOwn(target, "c")).toBe(false);
		expect(patch.installed).toBe(false);
		// a later rollback is a clean no-op
		expect(() => patch.restore()).not.toThrow();
	});

	test("non-configurable first name leaves the target untouched", () => {
		const target = new Target();
		Object.defineProperty(target, "a", {
			value: target.a,
			configurable: false,
			writable: true,
		});
		const patch = new DescriptorPatch(target, ["a", "b"]);
		expect(() =>
			patch.install({ a: wrapper("wrapped-a"), b: wrapper("wrapped-b") }),
		).toThrow(TypeError);
		expect(Object.hasOwn(target, "b")).toBe(false);
		expect(Object.hasOwn(target, "a")).toBe(true);
		expect(patch.installed).toBe(false);
	});

	test("per-instance scope: prototype and sibling instances stay untouched", () => {
		const first = new Target();
		const second = new Target();
		const patch = new DescriptorPatch(first, ["a"]);
		patch.install({ a: wrapper("wrapped-a") });
		expect(first.a("x")).toBe("wrapped-a:x");
		expect(second.a("x")).toBe("a:x:instance");
		expect(Object.hasOwn(second, "a")).toBe(false);
		expect(Target.prototype.a).toBe(second.a);
		patch.restore();
		expect(first.a).toBe(second.a);
	});

	test("restore before install is a no-op; install after restore throws", () => {
		const target = new Target();
		const patch = new DescriptorPatch(target, ["a"]);
		expect(() => patch.restore()).not.toThrow();
		expect(() => patch.install({ a: wrapper("wrapped-a") })).toThrow(
			/already restored/,
		);
		expect(Object.hasOwn(target, "a")).toBe(false);
	});

	test("a missing wrapper for a captured name fails transactionally", () => {
		const target = new Target();
		const patch = new DescriptorPatch(target, ["a", "b"]);
		expect(() => patch.install({ a: wrapper("wrapped-a") })).toThrow(
			/no wrapper captured/,
		);
		expect(Object.hasOwn(target, "a")).toBe(false);
		expect(Object.hasOwn(target, "b")).toBe(false);
		expect(patch.installed).toBe(false);
	});

	test("captured descriptors are read at construction, before install", () => {
		const target = new Target();
		const originalA = target.a;
		const patch = new DescriptorPatch(target, ["a"]);
		Object.defineProperty(target, "a", {
			value: () => "replaced",
			configurable: true,
		});
		patch.install({ a: wrapper("wrapped-a") });
		expect(target.a("x")).toBe("wrapped-a:x");
		patch.restore();
		// the descriptor captured at construction time wins
		expect(target.a).toBe(originalA);
	});

	test("a second install throws and never replaces the installed wrapper", () => {
		const target = new Target();
		const patch = new DescriptorPatch(target, ["a", "b"]);
		patch.install({
			a: wrapper("wrapped-a"),
			b: wrapper("wrapped-b"),
		});
		expect(() =>
			patch.install({
				a: wrapper("second-a"),
				b: wrapper("second-b"),
			}),
		).toThrow(/already installed/);
		// the first install's wrappers are untouched by the rejected reinstall
		expect(target.a("x")).toBe("wrapped-a:x");
		expect(target.b("y")).toBe("wrapped-b:y");
		expect(patch.installed).toBe(true);
		patch.restore();
		expect(target.a("x")).toBe("a:x:instance");
		expect(Object.hasOwn(target, "a")).toBe(false);
	});

	test("duplicate capture names are deduped preserving first-seen order", () => {
		const target = new Target();
		const patch = new DescriptorPatch(target, ["a", "b", "a", "c", "b"]);
		expect(patch.names).toEqual(["a", "b", "c"]);
		patch.install({
			a: wrapper("wrapped-a"),
			b: wrapper("wrapped-b"),
			c: wrapper("wrapped-c"),
		});
		expect(target.a("x")).toBe("wrapped-a:x");
		expect(target.b("y")).toBe("wrapped-b:y");
		expect(target.c("z")).toBe("wrapped-c:z");
		patch.restore();
		expect(target.a("x")).toBe("a:x:instance");
		expect(Object.hasOwn(target, "b")).toBe(false);
		expect(Object.hasOwn(target, "c")).toBe(false);
	});
});
