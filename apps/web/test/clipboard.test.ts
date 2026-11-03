import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "../src/lib/clipboard";

afterEach(() => vi.unstubAllGlobals());

it("falls back to selectable text when browser clipboard permission is denied", async () => {
	let copied = "";
	let selected = "";
	let removed = false;
	const input = {
		value: "",
		style: {},
		select() {
			selected = this.value;
		},
		remove() {
			removed = true;
		},
	};
	vi.stubGlobal("navigator", {
		clipboard: {
			writeText: async () => {
				throw new Error("Denied");
			},
		},
	});
	vi.stubGlobal("document", {
		createElement: () => input,
		body: { append: () => {} },
		execCommand: (command: string) => {
			if (command === "copy") copied = selected;
			return true;
		},
	});
	await copyText("http://192.168.1.20:4180");
	expect(copied).toBe("http://192.168.1.20:4180");
	expect(removed).toBe(true);
});
