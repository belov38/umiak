// Key chords and modifiers of the desktop tools (S10 12.2).
import { describe, expect, it } from "vitest";
import { KEY_NAMES, parseChord, parseModifiers } from "../src/desktop/keys.ts";
import { ToolError } from "../src/errors.ts";

function failure(f: () => unknown): ToolError {
	try {
		f();
	} catch (err) {
		if (err instanceof ToolError) return err;
		throw err;
	}
	throw new Error("did not throw");
}

describe("parseChord", () => {
	it("splits a chord on +", () => {
		expect(parseChord("ctrl+shift+t")).toEqual(["ctrl", "shift", "t"]);
		expect(parseChord("alt+f4")).toEqual(["alt", "f4"]);
	});

	it("takes one key, named or printable", () => {
		expect(parseChord("enter")).toEqual(["enter"]);
		expect(parseChord("/")).toEqual(["/"]);
		expect(parseChord("5")).toEqual(["5"]);
		expect(parseChord("f24")).toEqual(["f24"]);
	});

	it("lowercases names and ASCII letters, trims blanks, keeps other characters", () => {
		expect(parseChord(" Ctrl + Enter ")).toEqual(["ctrl", "enter"]);
		expect(parseChord("ctrl+T")).toEqual(["ctrl", "t"]);
		expect(parseChord("Shift+A")).toEqual(["shift", "a"]);
		// not a letter of the ASCII vocabulary: kept as typed
		expect(parseChord("\u00c9")).toEqual(["\u00c9"]);
	});

	it("reads a plus sign as the last key", () => {
		expect(parseChord("+")).toEqual(["+"]);
		expect(parseChord("ctrl++")).toEqual(["ctrl", "+"]);
	});

	it("an unknown name is invalid_action and lists the valid names", () => {
		const e = failure(() => parseChord("hyper+a"));
		expect(e.code).toBe("invalid_action");
		expect(e.message).toContain('"hyper"');
		for (const name of ["ctrl", "enter", "pagedown", "f1-f24", "printscreen"]) {
			expect(e.hint).toContain(name);
		}
	});

	it("rejects an empty chord, an empty key and f25", () => {
		for (const bad of ["", "  ", "ctrl+", "ctrl++a", "f25", "ab", "ctrl+ab"]) {
			expect(failure(() => parseChord(bad)).code, bad).toBe("invalid_action");
		}
	});

	it("KEY_NAMES has the vocabulary of S10 12.2", () => {
		expect(KEY_NAMES).toContain("meta");
		expect(KEY_NAMES).toContain("f24");
		expect(KEY_NAMES).not.toContain("f25");
		expect(KEY_NAMES).not.toContain("a");
	});
});

describe("parseModifiers", () => {
	it("accepts the four modifiers in any case", () => {
		expect(parseModifiers(["Ctrl", "shift"])).toEqual(["ctrl", "shift"]);
	});

	it("an unknown one is invalid_action", () => {
		const e = failure(() => parseModifiers(["ctrl", "super"]));
		expect(e.code).toBe("invalid_action");
		expect(e.hint).toContain("meta");
	});
});
