// Golden tool list (S11 7.1, 14.1): tools/list as a client sees it equals
// golden/tools-list.json, has exactly the 39 tools of 8.1-8.7 in order, fits
// the 40 000 character budget, and keeps every name of main (names are a
// contract). UPDATE_GOLDEN=1 rewrites the file (scripts/golden.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildGolden,
	formatGolden,
	GOLDEN_PATH,
	type Golden,
	writeGolden,
} from "../scripts/golden.ts";
import { type Harness, startHarness } from "./helpers/harness.ts";

/** Spec 8.1-8.7, in the order tools/list publishes. */
const TOOL_NAMES = [
	// 8.1 catalog
	"limits_get",
	"templates_list",
	// 8.2 sandbox
	"sandbox_create",
	"sandbox_list",
	"sandbox_get",
	"sandbox_update",
	"sandbox_stop",
	"sandbox_resume",
	"sandbox_cancel_start",
	"sandbox_fork",
	"sandbox_recover",
	"sandbox_delete",
	// 8.3 commands
	"exec_run",
	"exec_start",
	"exec_output",
	"exec_list",
	"exec_kill",
	// 8.4 files
	"files_read",
	"files_write",
	"files_edit",
	"files_list",
	"files_stat",
	"files_delete",
	// 8.5 ports
	"port_expose",
	"port_list",
	"port_unexpose",
	// 8.6 snapshots
	"snapshot_save",
	"snapshot_list",
	"snapshot_delete",
	// 8.7 desktop
	"desktop_url",
	"computer_screenshot",
	"computer_click",
	"computer_move",
	"computer_drag",
	"computer_scroll",
	"computer_key",
	"computer_type",
	"computer_clipboard_read",
	"computer_clipboard_write",
];

/** Spec 7.1: the whole tools/list response, all toolsets. */
const BUDGET_CHARS = 40_000;

let h: Harness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The published list of the real server: a person, all toolsets, not pinned. */
async function published() {
	h = await startHarness();
	return h.conn.client.listTools();
}

/** Names in the golden file `oldText` that `now` no longer has. */
function missingNames(oldText: string, now: Golden): string[] {
	const have = new Set(now.tools.map((t) => t.name));
	return (JSON.parse(oldText) as Golden).tools
		.map((t) => t.name)
		.filter((n) => !have.has(n));
}

function readGolden(): Golden {
	return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
}

describe("golden tools/list", () => {
	it("is rewritten on UPDATE_GOLDEN=1", () => {
		if (process.env.UPDATE_GOLDEN !== "1") return;
		writeGolden();
	});

	it("the file is deterministic: 2-space JSON, trailing newline, exactly what the script writes", () => {
		const text = readFileSync(GOLDEN_PATH, "utf8");
		expect(text.endsWith("}\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
		expect(text).toBe(formatGolden(buildGolden()));
		expect(text).toBe(formatGolden(JSON.parse(text) as Golden));
	});

	it("tools/list equals golden/tools-list.json: name, title, description, inputSchema, annotations", async () => {
		const listed = await published();
		const seen = listed.tools.map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.inputSchema,
			annotations: t.annotations,
		}));
		expect(seen).toEqual(readGolden().tools);
	});

	it("has exactly the 39 tools in the order of 8.1-8.7", async () => {
		expect(TOOL_NAMES).toHaveLength(39);
		expect(new Set(TOOL_NAMES).size).toBe(39);
		const listed = await published();
		expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
		expect(readGolden().tools.map((t) => t.name)).toEqual(TOOL_NAMES);
	});

	it(`the whole tools/list response is at most ${BUDGET_CHARS} characters`, async () => {
		const listed = await published();
		expect(JSON.stringify(listed).length).toBeLessThanOrEqual(BUDGET_CHARS);
	});

	it("keeps every tool name of origin/main", (ctx) => {
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		try {
			git("rev-parse", "--verify", "--quiet", "origin/main^{commit}");
		} catch {
			ctx.skip("origin/main not available: the name check cannot run here");
			return;
		}
		const path = "apps/mcp/golden/tools-list.json";
		if (git("ls-tree", "origin/main", "--", path).trim() === "") {
			ctx.skip(`${path} is not on origin/main yet: nothing to compare`);
			return;
		}
		expect(
			missingNames(git("show", `origin/main:${path}`), readGolden()),
		).toEqual([]);
	});

	it("the name comparison reports a removed or renamed tool", () => {
		const old = JSON.stringify({
			tools: [{ name: "a_one" }, { name: "b_two" }],
		});
		expect(missingNames(old, { tools: [{ name: "a_one" }] } as Golden)).toEqual(
			["b_two"],
		);
		expect(
			missingNames(old, {
				tools: [{ name: "a_one" }, { name: "b_two" }, { name: "c_new" }],
			} as Golden),
		).toEqual([]);
		expect(
			missingNames(old, {
				tools: [{ name: "a_one" }, { name: "b_2" }],
			} as Golden),
		).toEqual(["b_two"]);
	});
});
