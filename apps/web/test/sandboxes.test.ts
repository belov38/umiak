// The sandbox list (S8 §9.4): filters and row actions.
import { describe, expect, it } from "vitest";
import { formatAgo } from "../src/lib/format.ts";
import {
	canFork,
	canResume,
	canStop,
	listQuery,
	parseLabelFilter,
} from "../src/lib/sandboxes.ts";

describe("parseLabelFilter", () => {
	it("pairs separated by commas or spaces", () => {
		expect(parseLabelFilter(" session=42, ci=true  x=")).toEqual({
			ok: true,
			labels: { session: "42", ci: "true", x: "" },
		});
		expect(parseLabelFilter("")).toEqual({ ok: true, labels: {} });
		expect(parseLabelFilter("novalue").ok).toBe(false);
		expect(parseLabelFilter("=v").ok).toBe(false);
	});
});

describe("listQuery", () => {
	it("sends only set filters", () => {
		expect(listQuery({ q: " ", state: "all", labels: {} }, undefined)).toEqual({
			limit: 50,
		});
		expect(
			listQuery({ q: "ci", state: "ready", labels: { a: "1" } }, "c1", 20),
		).toEqual({
			q: "ci",
			state: "ready",
			label: ["a=1"],
			limit: 20,
			cursor: "c1",
		});
	});
});

describe("row actions", () => {
	const sb = (state: string, blocked = false) =>
		({ state, blocked }) as Parameters<typeof canStop>[0];
	it("a blocked sandbox may stop, not resume or fork", () => {
		expect(canStop(sb("ready", true))).toBe(true);
		expect(canFork(sb("ready", true))).toBe(false);
		expect(canResume(sb("stopped", true))).toBe(false);
		expect(canResume(sb("stopped"))).toBe(true);
		expect(canFork(sb("creating"))).toBe(false);
	});
});

describe("formatAgo", () => {
	const now = Date.parse("2026-10-31T12:00:00.000Z");
	it("relative up to a week", () => {
		expect(formatAgo("2026-10-31T11:59:30.000Z", now)).toBe("just now");
		expect(formatAgo("2026-10-31T11:55:00.000Z", now)).toBe("5 min ago");
		expect(formatAgo("2026-10-31T09:00:00.000Z", now)).toBe("3 h ago");
		expect(formatAgo("2026-10-20T12:00:00.000Z", now)).toBe(
			"2026-10-20 12:00 UTC",
		);
		expect(formatAgo(null, now)).toBe("—");
	});
});
