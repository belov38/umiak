// Command tools (S11 8.3, 9.1-9.3, 10.2) against the fake API, and ByteTail.
import { createHash } from "node:crypto";
import { Command, Umiak } from "@umiak/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESULT_CHARS } from "../src/output/result.ts";
import { ByteTail } from "../src/output/tail.ts";
import { publishedJsonSchemaOf, selectTools } from "../src/registry.ts";
import { lintToolName, lintToolSchema } from "../src/schema-rules.ts";
import { COMMAND_TOOLS, KILL_GRACE_MS } from "../src/tools/commands.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { REPLAYED_LINE } from "../src/tools/sandbox-view.ts";
import {
	emitPattern,
	FAKE_TEAM,
	FAKE_TOKENS,
	INJECT_FENCE_END,
} from "./fake-api/index.ts";
import { type Answer, type Harness, startHarness } from "./helpers/harness.ts";

let h: Harness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function start(o: Parameters<typeof startHarness>[0] = {}) {
	h = await startHarness(o);
	return h;
}

/** A ready sandbox of the fake; returns its id. */
async function sandbox(hh: Harness, slug?: string): Promise<string> {
	const r = await hh.call("sandbox_create", slug === undefined ? {} : { slug });
	expect(r.json.state).toBe("ready");
	return r.json.id as string;
}

const sha256 = (s: string | Uint8Array) =>
	createHash("sha256").update(s).digest("hex");

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The text of the fenced block of `stream`, or undefined when there is none. */
function fenced(a: Answer, stream: "stdout" | "stderr"): string | undefined {
	const all = a.texts.join("\n");
	const m = new RegExp(
		`<<<umiak-untrusted id=([0-9a-f]+) stream=${stream}>>>\\n([\\s\\S]*?)\\n<<<end id=\\1>>>`,
	).exec(all);
	return m?.[2];
}

const COMMANDS = (sb: string) => `/v1/sandboxes/${sb}/commands`;

describe("ByteTail", () => {
	it("keeps the last max bytes across wraps, with their offsets", () => {
		const t = new ByteTail(5);
		t.push(Uint8Array.from([1, 2, 3]), 3);
		expect([t.from, t.to]).toEqual([0, 3]);
		expect([...t.bytes()]).toEqual([1, 2, 3]);
		t.push(Uint8Array.from([4, 5, 6, 7]), 7);
		expect([t.from, t.to]).toEqual([2, 7]);
		expect([...t.bytes()]).toEqual([3, 4, 5, 6, 7]);
		t.push(Uint8Array.from([8]), 8);
		expect([...t.bytes()]).toEqual([4, 5, 6, 7, 8]);
	});

	it("a push larger than max keeps its end", () => {
		const t = new ByteTail(3);
		t.push(Uint8Array.from([1, 2, 3, 4, 5, 6]), 106);
		expect([t.from, t.to]).toEqual([103, 106]);
		expect([...t.bytes()]).toEqual([4, 5, 6]);
	});

	it("truncate drops what is held and starts again at availableFrom", () => {
		const t = new ByteTail(4);
		t.push(Uint8Array.from([1, 2]), 2);
		t.truncate(50);
		expect([t.from, t.to, t.bytes().length]).toEqual([50, 50, 0]);
		t.push(Uint8Array.from([9]), 51);
		expect([t.from, t.to]).toEqual([50, 51]);
		expect([...t.bytes()]).toEqual([9]);
	});
});

describe("tool list", () => {
	it("has the 5 tools of 8.3 after the sandbox tools, with the table's annotations and scopes", () => {
		expect(COMMAND_TOOLS.map((t) => t.name)).toEqual([
			"exec_run",
			"exec_start",
			"exec_output",
			"exec_list",
			"exec_kill",
		]);
		expect(ALL_TOOLS.slice(12, 17).map((t) => t.name)).toEqual(
			COMMAND_TOOLS.map((t) => t.name),
		);
		const table: Record<string, [boolean, boolean, boolean, boolean]> = {
			exec_run: [false, false, false, true],
			exec_start: [false, false, false, true],
			exec_output: [true, false, true, false],
			exec_list: [true, false, true, false],
			exec_kill: [false, false, true, true],
		};
		for (const t of COMMAND_TOOLS) {
			const a = t.annotations;
			expect(
				[a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint],
				t.name,
			).toEqual(table[t.name]);
			expect(t.toolset).toBe("core");
			expect(t.sandboxArg).toBe(true);
			expect(t.hiddenWhenPinned).toBeFalsy();
		}
		expect(
			Object.fromEntries(COMMAND_TOOLS.map((t) => [t.name, [...t.scopes]])),
		).toEqual({
			exec_run: ["commands:exec"],
			exec_start: ["commands:exec"],
			exec_output: ["commands:read"],
			exec_list: ["commands:read"],
			exec_kill: ["commands:exec"],
		});
	});

	it("schemas pass the 7.2 linter; signal is a string enum", () => {
		for (const t of COMMAND_TOOLS) {
			expect(lintToolName(t.name)).toEqual([]);
			expect(lintToolSchema(t.name, publishedJsonSchemaOf(t, false))).toEqual(
				[],
			);
		}
		const kill = COMMAND_TOOLS.find((t) => t.name === "exec_kill");
		const schema = publishedJsonSchemaOf(kill as never, false) as {
			properties: Record<string, { enum?: unknown[] }>;
		};
		expect(schema.properties.signal?.enum).toEqual([
			"SIGTERM",
			"SIGINT",
			"SIGKILL",
		]);
	});

	it("descriptions keep what the model must know", () => {
		const d = Object.fromEntries(
			COMMAND_TOOLS.map((t) => [t.name, t.description]),
		);
		for (const s of [
			"bash -lc",
			"PowerShell",
			"-y",
			"command_id",
			"exec_output",
			"600",
			"0 = none",
			"cancelling may leave the command running; use exec_list and exec_kill",
		]) {
			expect(d.exec_run).toContain(s);
		}
		for (const s of ["dev servers", "exec_output", "port_expose"]) {
			expect(d.exec_start).toContain(s);
		}
		for (const t of COMMAND_TOOLS) {
			expect(t.description.length, t.name).toBeLessThanOrEqual(340);
		}
	});

	it("the 5 tools stay within their share of the 40 000 character budget", async () => {
		const { conn } = await start({ server: { tools: COMMAND_TOOLS } });
		const listed = await conn.client.listTools();
		expect(listed.tools).toHaveLength(5);
		expect(JSON.stringify(listed).length).toBeLessThanOrEqual(
			Math.floor((5 / 38) * 40_000),
		);
		expect(JSON.stringify(listed)).not.toContain("9007199254740991");
		// Every tool so far (8.1-8.3) within the share of its 16 tools.
		const all = await startHarness();
		const whole = await all.conn.client.listTools();
		await all.close();
		expect(whole.tools).toHaveLength(ALL_TOOLS.length);
		expect(JSON.stringify(whole).length).toBeLessThanOrEqual(40_000);
	});

	it("pinned mode keeps all five without the sandbox argument", () => {
		const tools = selectTools({ tools: COMMAND_TOOLS, pinnedSandbox: "sb_1" });
		expect(tools).toHaveLength(5);
		for (const t of tools) {
			const s = publishedJsonSchemaOf(t, true) as {
				properties: Record<string, unknown>;
			};
			expect(s.properties.sandbox).toBeUndefined();
		}
	});
});

describe("exec_run", () => {
	it("a short command: exited, exit code, fenced output, no truncation note", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "echo привет \u{1f600} мир",
		});
		expect(r.isError).toBe(false);
		const size = Buffer.byteLength("привет \u{1f600} мир\n");
		expect(r.json).toMatchObject({
			command_id: expect.stringMatching(/^cmd_/),
			status: "exited",
			exit_code: 0,
			stdout: { size, from: 0, to: size },
			stderr: { size: 0, from: 0, to: 0 },
			idempotency_key: expect.stringMatching(UUID),
		});
		expect(r.json.stdout_offset).toBeUndefined();
		expect(r.json.replayed).toBeUndefined();
		expect(fenced(r, "stdout")).toBe("привет \u{1f600} мир\n");
		expect(fenced(r, "stderr")).toBeUndefined();
		expect(r.lines).not.toContain("last ");
		expect(r.lines).not.toContain(" of ");

		const err = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:stderr boom",
		});
		expect(fenced(err, "stderr")).toBe("boom\n");
		const exit = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:exit 3",
		});
		expect(exit.json).toMatchObject({ status: "exited", exit_code: 3 });
	});

	it("sends mode stream, base64, the derived key and the process timeout", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		await hh.call("exec_run", {
			sandbox: sb,
			command: "echo a",
			cwd: "app",
			env: { CI: "1" },
			user: "root",
			idempotency_key: "k-1",
		});
		await hh.call("exec_run", {
			sandbox: sb,
			command: "echo b",
			timeout_seconds: 0,
		});
		await hh.call("exec_run", {
			sandbox: sb,
			command: "echo c",
			timeout_seconds: 5,
		});
		const posts = hh.to("POST", COMMANDS(sb));
		expect(posts.map((p) => p.body)).toEqual([
			{
				command: "echo a",
				cwd: "app",
				env: { CI: "1" },
				user: "root",
				timeoutSeconds: 600,
				mode: "stream",
				encoding: "base64",
			},
			{
				command: "echo b",
				timeoutSeconds: null,
				mode: "stream",
				encoding: "base64",
			},
			{
				command: "echo c",
				timeoutSeconds: 5,
				mode: "stream",
				encoding: "base64",
			},
		]);
		expect(posts[0]?.headers.get("idempotency-key")).toBe(
			`mcp:exec_run:${sb}:k-1`,
		);
	});

	it("a long output gives its tail with the header and the 'last N of M' line", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:emit 200000:4096:0",
			max_output_bytes: 16384,
		});
		const out = r.json.stdout;
		expect(out.size).toBe(200000);
		expect(out.to).toBe(200000);
		expect(out.to - out.from).toBeLessThanOrEqual(16384);
		expect(out.to - out.from).toBeGreaterThan(16384 - 4);
		expect(r.lines).toContain(
			`stdout: last ${out.to - out.from} of 200000 bytes. Earlier output: exec_output with stdout_offset=0.`,
		);
		const expected = emitPattern(200000).subarray(out.from).toString("utf8");
		expect(fenced(r, "stdout")).toBe(expected);
	});

	it("still running after wait_seconds: command_id, offsets, the exec_output hint; the chain reads every byte", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const total = 200000;
		const t0 = Date.now();
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: `fake:emit ${total}:1000:40`,
			wait_seconds: 2,
		});
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(r.json, r.texts.join("\n")).toMatchObject({
			command_id: expect.stringMatching(/^cmd_/),
			status: "running",
		});
		const id = r.json.command_id as string;
		expect(r.json.stdout_offset).toBe(r.json.stdout.to);
		expect(r.json.stderr_offset).toBe(0);
		expect(r.lines).toContain(
			`call exec_output with command_id=${id}, stdout_offset=${r.json.stdout_offset}, stderr_offset=0`,
		);
		// The window ends on a character boundary: it decodes like the pattern.
		const pattern = emitPattern(total);
		let text = fenced(r, "stdout") ?? "";
		expect(text).toBe(
			pattern.subarray(r.json.stdout.from, r.json.stdout.to).toString("utf8"),
		);
		const first = r.json.stdout.from as number;
		let offsets = {
			stdout_offset: r.json.stdout_offset as number,
			stderr_offset: 0,
		};
		let done = false;
		for (let i = 0; i < 100 && !done; i++) {
			const o = await hh.call("exec_output", {
				sandbox: sb,
				command_id: id,
				...offsets,
				wait_seconds: 5,
			});
			expect(o.isError).toBe(false);
			// Each window starts where the previous one ended.
			expect(o.json.stdout.from).toBe(offsets.stdout_offset);
			text += fenced(o, "stdout") ?? "";
			offsets = {
				stdout_offset: o.json.stdout_offset,
				stderr_offset: o.json.stderr_offset,
			};
			done = o.json.done === true;
		}
		expect(done).toBe(true);
		expect(offsets.stdout_offset).toBe(total);
		expect(sha256(text)).toBe(sha256(pattern.subarray(first).toString("utf8")));
		expect(hh.api.state.commands.size).toBe(1);
	}, 30_000);

	it("an NDJSON stream cut in the middle is resumed: the same bytes", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		hh.api.script.breakStreamAfterBytes = 40_000;
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:emit 100000:1000:0",
			max_output_bytes: 65536,
			wait_seconds: 20,
		});
		expect(r.json).toMatchObject({
			status: "exited",
			stdout: { size: 100000, to: 100000 },
		});
		expect(fenced(r, "stdout")).toBe(
			emitPattern(100000).subarray(r.json.stdout.from).toString("utf8"),
		);
		const id = r.json.command_id as string;
		expect(hh.to("GET", `${COMMANDS(sb)}/${id}/stream`)).toHaveLength(1);
		expect(hh.api.state.commands.size).toBe(1);
	});

	it("a stream that fails for good after the start names the command to read on", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		hh.api.script.breakStreamAfterBytes = 1000;
		hh.api.script.failNext = {
			path: /^GET .*\/stream$/,
			status: 409,
			code: "sandbox_not_ready",
			retryable: false,
		};
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:emit 100000:1000:20",
			idempotency_key: "k-lost",
		});
		const id = [...hh.api.state.commands.values()][0]?.id as string;
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: sandbox_not_ready");
		// The API's retryable and the hint of its code stay; where to read on is added.
		expect(r.texts[0]).toContain("retryable: false");
		expect(r.texts[0]).toContain("sandbox_resume");
		expect(r.texts[0]).toContain(`exec_output command_id=${id}`);
		expect(r.texts[0]).toContain("idempotency_key: k-lost");
	});

	it("zero wait preserves replay when the timer falls between command headers and started frame", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const handle = hh.umiak.sandboxes.handle(sb);
		const command = new Command(handle, "cmd_headergap");
		const run = vi.spyOn(handle, "run").mockImplementation(async function* (
			_command,
			options = {},
		) {
			options.onStart?.(command);
			// Let the zero-wait timer fire before the stream's started frame arrives.
			await new Promise((resolve) => setTimeout(resolve, 20));
			options.signal?.throwIfAborted();
			options.onStarted?.({ commandId: command.id, replayed: true });
		});
		const handles = vi
			.spyOn(hh.umiak.sandboxes, "handle")
			.mockReturnValue(handle);
		try {
			const result = await hh.call("exec_run", {
				sandbox: sb,
				command: "echo replay",
				wait_seconds: 0,
				idempotency_key: "header-gap",
			});
			expect(result.isError).toBe(false);
			expect(result.json).toMatchObject({
				command_id: command.id,
				replayed: true,
				status: "running",
			});
		} finally {
			handles.mockRestore();
			run.mockRestore();
		}
	});

	it("wait_seconds 0 still gets the command id; a retry with the key attaches", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:sleep 30",
			wait_seconds: 0,
			idempotency_key: "k-zero",
		});
		expect(r.isError, r.texts.join("\n")).toBe(false);
		expect(r.json).toMatchObject({
			command_id: expect.stringMatching(/^cmd_/),
			status: "running",
			stdout_offset: 0,
			stderr_offset: 0,
			idempotency_key: "k-zero",
		});
		const again = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:sleep 30",
			wait_seconds: 0,
			idempotency_key: "k-zero",
		});
		expect(again.json).toMatchObject({
			command_id: r.json.command_id,
			status: "running",
			replayed: true,
		});
		expect(hh.to("POST", COMMANDS(sb))).toHaveLength(2);
		expect(hh.api.state.commands.size).toBe(1);
	});

	it("a POST answered after the wait (starting sandbox) still gives the command id", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		hh.api.script.holdCommandsPostMs = 3000;
		const t0 = Date.now();
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:sleep 30",
			wait_seconds: 1,
		});
		expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
		expect(r.isError, r.texts.join("\n")).toBe(false);
		expect(r.json).toMatchObject({
			command_id: [...hh.api.state.commands.keys()][0],
			status: "running",
		});
		expect(r.lines).toContain("call exec_output with command_id=");
	});

	// The one real-time test of the 50 s budget: it takes about 49 s.
	it("SLOW (~49 s): a POST held for 70 s answers within 50 s with deadline_exceeded; the key attaches to the same command", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		hh.api.script.holdCommandsPostMs = 70_000;
		const t0 = Date.now();
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "echo once",
			wait_seconds: 50,
			idempotency_key: "k-held",
		});
		expect(Date.now() - t0).toBeLessThan(50_000);
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: deadline_exceeded");
		expect(r.texts[0]).toContain("retryable: true");
		expect(r.texts[0]).toContain("idempotency_key: k-held");
		const again = await hh.call("exec_run", {
			sandbox: sb,
			command: "echo once",
			wait_seconds: 50,
			idempotency_key: "k-held",
		});
		expect(again.json).toMatchObject({
			status: "exited",
			replayed: true,
			idempotency_key: "k-held",
		});
		expect(again.lines).toContain(REPLAYED_LINE);
		expect(fenced(again, "stdout")).toBe("once\n");
		expect(hh.api.state.commands.size).toBe(1);
	}, 70_000);

	it("one model key on two sandboxes gives two commands; other arguments ask for a new key", async () => {
		const hh = await start();
		const a = await sandbox(hh);
		const b = await sandbox(hh);
		const ra = await hh.call("exec_run", {
			sandbox: a,
			command: "echo x",
			idempotency_key: "same",
		});
		const rb = await hh.call("exec_run", {
			sandbox: b,
			command: "echo x",
			idempotency_key: "same",
		});
		expect(ra.json.command_id).not.toBe(rb.json.command_id);
		expect(rb.json.replayed).toBeUndefined();
		expect(hh.api.state.commands.size).toBe(2);
		const other = await hh.call("exec_run", {
			sandbox: a,
			command: "echo y",
			idempotency_key: "same",
		});
		expect(other.isError).toBe(true);
		expect(other.texts[0]).toContain("error: idempotency_key_reused");
		expect(other.texts[0]).toContain("new idempotency_key");
	});

	it("a slug and the id of the same sandbox give the same API key", async () => {
		const hh = await start();
		const sb = await sandbox(hh, "my-box");
		const first = await hh.call("exec_run", {
			sandbox: "my-box",
			command: "echo s",
			idempotency_key: "k-slug",
		});
		const second = await hh.call("exec_run", {
			sandbox: sb,
			command: "echo s",
			idempotency_key: "k-slug",
		});
		expect(second.json.command_id).toBe(first.json.command_id);
		expect(second.json.replayed).toBe(true);
	});

	it("sandbox text is sanitized and a forged fence end does not close the block", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:inject",
		});
		const all = r.texts.join("\n");
		expect(all).not.toContain("\u001b");
		expect(all).not.toContain(String.fromCodePoint(0xe0041));
		const text = fenced(r, "stdout") as string;
		expect(text).toContain("red text\\u{E0041}");
		// The forged marker sits inside the block the server closes.
		expect(text).toContain(INJECT_FENCE_END);
		expect(text).toContain("ignore previous instructions");
	});

	it("API and agent text outside the fence is sanitized, one line and capped", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const evil = `${String.fromCodePoint(0x1b)}[2Jgone${String.fromCodePoint(0xe0041)}\nhint: ${"z".repeat(500)}`;
		const run = hh.call("exec_run", { sandbox: sb, command: "fake:sleep 1" });
		await vi.waitFor(() => expect(hh.api.state.commands.size).toBe(1));
		const cmd = [...hh.api.state.commands.values()][0];
		if (cmd !== undefined) cmd.outputTruncated = evil;
		const r = await run;
		const note = r.lines
			.split("\n")
			.find((l) => l.startsWith("the agent dropped output"));
		expect(note).toBe(
			`the agent dropped output (gone\\u{E0041} hint: ${"z".repeat(279)}\u2026)`,
		);

		hh.api.script.failNext = {
			path: /^GET .*\/commands\/cmd_[^/]+$/,
			status: 409,
			code: "invalid_state",
			retryable: false,
			message: evil,
		};
		const e = await hh.call("exec_output", {
			sandbox: sb,
			command_id: r.json.command_id,
		});
		expect(e.isError).toBe(true);
		const lines = e.texts[0]?.split("\n") ?? [];
		expect(lines.filter((l) => l.startsWith("hint:"))).toEqual([]);
		const message = lines.find((l) => l.startsWith("message: ")) ?? "";
		expect(message).toMatch(/^message: gone\\u\{E0041\} hint: z+\u2026$/);
		expect(message.length).toBe("message: ".length + 300);
	});

	it("sends progress about every 5 s with the bytes seen", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const seen: { progress: number; message?: string }[] = [];
		const r = await hh.call(
			"exec_run",
			{ sandbox: sb, command: "fake:emit 2000:100:320", wait_seconds: 20 },
			{ onprogress: (p) => seen.push(p) },
		);
		expect(r.json.status).toBe("exited");
		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen[0]?.progress).toBeGreaterThanOrEqual(4.5);
		expect(seen[0]?.progress).toBeLessThanOrEqual(5.5);
		expect(seen[0]?.message).toMatch(/^\d+ bytes of output so far$/);
	}, 20_000);
});

describe("exec_run cancellation", () => {
	async function cancelRun(cancelledByClient: boolean) {
		const hh = await start({
			server: { wasCancelledByClient: () => cancelledByClient },
		});
		const sb = await sandbox(hh);
		const ac = new AbortController();
		const pending = hh.conn.client.callTool(
			{
				name: "exec_run",
				arguments: { sandbox: sb, command: "fake:sleep 30" },
			},
			{ signal: ac.signal },
		);
		await vi.waitFor(() => expect(hh.to("POST", COMMANDS(sb))).toHaveLength(1));
		const id = [...hh.api.state.commands.values()][0]?.id as string;
		// Let the stream open, so the tool knows the command id.
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		await expect(pending).rejects.toThrow();
		return { hh, sb, id };
	}

	it("a client cancel (stdio notifications/cancelled) kills the command with graceMs 5000", async () => {
		const { hh, sb, id } = await cancelRun(true);
		await vi.waitFor(() =>
			expect(hh.to("POST", `${COMMANDS(sb)}/${id}/kill`)).toHaveLength(1),
		);
		expect(hh.to("POST", `${COMMANDS(sb)}/${id}/kill`)[0]?.body).toEqual({
			graceMs: KILL_GRACE_MS,
		});
		expect(KILL_GRACE_MS).toBe(5000);
		await vi.waitFor(() =>
			expect(hh.api.state.commands.get(id)?.status).toBe("killed"),
		);
	});

	it("an abort that is not a client cancel (stdin close, HTTP) leaves the command running", async () => {
		const { hh, id } = await cancelRun(false);
		await new Promise((r) => setTimeout(r, 300));
		expect(hh.api.journal.filter((l) => l.includes("/kill"))).toEqual([]);
		expect(hh.api.state.commands.get(id)?.status).toBe("running");
	});
});

describe("exec_start", () => {
	it("starts detached and answers with command_id, pid and the key; a repeat is replayed", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
			idempotency_key: "k-start",
		});
		expect(r.json).toMatchObject({
			command_id: expect.stringMatching(/^cmd_/),
			pid: expect.any(Number),
			status: "running",
			idempotency_key: "k-start",
		});
		expect(r.lines).toContain("exec_output");
		const post = hh.to("POST", COMMANDS(sb))[0];
		expect(post?.body).toEqual({ command: "fake:sleep 30", mode: "detached" });
		expect(post?.headers.get("idempotency-key")).toBe(
			`mcp:exec_start:${sb}:k-start`,
		);
		const again = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
			idempotency_key: "k-start",
		});
		expect(again.json).toMatchObject({
			command_id: r.json.command_id,
			replayed: true,
		});
		expect(again.lines).toContain(REPLAYED_LINE);
		expect(hh.api.state.commands.size).toBe(1);
	});

	it("sends timeout_seconds when positive; without a key one is generated", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
			timeout_seconds: 120,
		});
		expect(r.json.idempotency_key).toMatch(UUID);
		expect(hh.to("POST", COMMANDS(sb))[0]?.body).toMatchObject({
			timeoutSeconds: 120,
		});
	});
});

describe("exec_output", () => {
	async function finished(hh: Harness, sb: string, command: string) {
		const r = await hh.call("exec_run", { sandbox: sb, command });
		expect(r.json.status).toBe("exited");
		return r.json.command_id as string;
	}

	it("without offsets gives the tail of each stream and done", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "fake:emit 100000:100000:0");
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			max_bytes: 2000,
		});
		expect(r.json).toMatchObject({
			command_id: id,
			status: "exited",
			exit_code: 0,
			stdout: { size: 100000, to: 100000, available_from: 0 },
			stdout_offset: 100000,
			stderr_offset: 0,
			done: true,
		});
		const from = r.json.stdout.from as number;
		expect(100000 - from).toBeLessThanOrEqual(2000);
		expect(r.lines).toContain(`stdout: last ${100000 - from} of 100000 bytes.`);
		expect(fenced(r, "stdout")).toBe(
			emitPattern(100000).subarray(from).toString("utf8"),
		);
	});

	it("with offsets reads forward within the budget", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "fake:emit 4000:4000:0");
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 0,
			stderr_offset: 0,
			max_bytes: 1024,
		});
		expect(r.json.stdout.from).toBe(0);
		expect(r.json.stdout.to).toBeLessThanOrEqual(1024);
		expect(r.json.stdout_offset).toBe(r.json.stdout.to);
		expect(r.json.done).toBeUndefined();
		expect(r.lines).toContain(
			`Later output: exec_output with stdout_offset=${r.json.stdout_offset}.`,
		);
		expect(fenced(r, "stdout")).toBe(
			emitPattern(4000).subarray(0, r.json.stdout_offset).toString("utf8"),
		);
	});

	it("an offset below available_from says how many bytes retention dropped", async () => {
		const hh = await start({ api: { retentionBytes: 10_000 } });
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "fake:emit 100000:100000:0");
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 0,
			stderr_offset: 0,
			max_bytes: 65536,
		});
		expect(r.json.stdout).toMatchObject({ available_from: 90000, to: 100000 });
		expect(r.json.stdout.from).toBeGreaterThanOrEqual(90000);
		expect(r.lines).toContain("stdout: 90000 bytes were dropped by retention");
		expect(r.json.done).toBe(true);
	});

	it("waits for new output and answers soon after the first chunk", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const s = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:emit 60:20:1500",
		});
		const id = s.json.command_id as string;
		const first = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 0,
			stderr_offset: 0,
		});
		expect(first.json.stdout_offset).toBe(20);
		const t0 = Date.now();
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 20,
			stderr_offset: 0,
			wait_seconds: 10,
		});
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(r.json).toMatchObject({ status: "running", stdout_offset: 40 });
		expect(r.lines).toContain("wait_seconds=50");
	});

	it("a wait ends at wait_seconds with the current state", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const s = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
		});
		const t0 = Date.now();
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: s.json.command_id,
			stdout_offset: 0,
			stderr_offset: 0,
			wait_seconds: 1,
		});
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(r.json).toMatchObject({ status: "running", stdout_offset: 0 });
		expect(r.json.done).toBeUndefined();
	});

	it("a long wait ends early enough for the reads after it on a slow API (7.5)", async () => {
		// A 10 s budget instead of 50 s: the margin after the wait is the same.
		const hh = await start({ server: { callBudgetMs: 10_000 } });
		const sb = await sandbox(hh);
		const s = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 60",
		});
		hh.api.script.slow = {
			path: /^GET \/v1\/sandboxes\/[^/]+\/commands\/cmd_[^/]+$/,
			ms: 2_000,
		};
		const t0 = Date.now();
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: s.json.command_id,
			stdout_offset: 0,
			stderr_offset: 0,
			wait_seconds: 50,
		});
		expect(r.isError, r.texts[0]).toBe(false);
		expect(r.json).toMatchObject({ status: "running", stdout_offset: 0 });
		expect(Date.now() - t0).toBeLessThan(10_000);
	}, 20_000);

	it("a stopped sandbox is sandbox_not_ready with the resume hint", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "echo kept");
		await hh.call("sandbox_stop", { sandbox: sb, wait: true });
		const r = await hh.call("exec_output", { sandbox: sb, command_id: id });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: sandbox_not_ready");
		expect(r.texts[0]).toContain("sandbox_resume");
	});

	it("a lone offset is rejected: both offsets or none", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "echo short");
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 0,
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: validation");
		expect(r.texts[0]).toContain("pass both offsets");
		expect(hh.requests.filter((q) => q.path.includes("/output"))).toEqual([]);
	});

	it("an offset past the end is a validation error", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const id = await finished(hh, sb, "echo short");
		const r = await hh.call("exec_output", {
			sandbox: sb,
			command_id: id,
			stdout_offset: 999,
			stderr_offset: 0,
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("stdout_offset");
	});
});

describe("output that sanitizing makes longer (9.2: the response stays under the cap)", () => {
	type Streams = Record<"stdout" | "stderr", Buffer>;
	const STREAM_NAMES = ["stdout", "stderr"] as const;

	/** Bytes of fenced text whose bytes are all controls (written as escapes). */
	function bytesOf(text: string | undefined): Buffer {
		const raw = (text ?? "").replace(/\\u\{([0-9A-F]+)\}/g, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		);
		return Buffer.from(raw, "latin1");
	}

	/** Fits the cap, every fence is closed, and each window holds exactly from..to. */
	function checkAnswer(a: Answer): Streams {
		expect(a.isError, a.texts.join("\n").slice(0, 500)).toBe(false);
		const chars = a.texts.reduce((n, t) => n + t.length, 0);
		expect(chars).toBeLessThanOrEqual(MAX_RESULT_CHARS);
		const all = a.texts.join("\n");
		const opened = all.match(/<<<umiak-untrusted id=/g)?.length ?? 0;
		expect(all.match(/\n<<<end id=[0-9a-f]+>>>/g)?.length ?? 0).toBe(opened);
		expect(all).not.toContain("response cut at");
		const out = {} as Streams;
		for (const s of STREAM_NAMES) {
			out[s] = bytesOf(fenced(a, s));
			expect(out[s].length, s).toBe(a.json[s].to - a.json[s].from);
		}
		return out;
	}

	/** exec_output from offset 0 to done; every answer checked. */
	async function readAll(
		hh: Harness,
		sb: string,
		id: string,
	): Promise<Streams> {
		const got: Record<"stdout" | "stderr", Buffer[]> = {
			stdout: [],
			stderr: [],
		};
		let offsets = { stdout_offset: 0, stderr_offset: 0 };
		for (let i = 0; i < 50; i++) {
			const o = await hh.call("exec_output", {
				sandbox: sb,
				command_id: id,
				...offsets,
				max_bytes: 65536,
			});
			const shown = checkAnswer(o);
			for (const s of STREAM_NAMES) {
				expect(o.json[s].from).toBe(offsets[`${s}_offset`]);
				got[s].push(shown[s]);
			}
			offsets = {
				stdout_offset: o.json.stdout_offset,
				stderr_offset: o.json.stderr_offset,
			};
			if (o.json.done === true) {
				return {
					stdout: Buffer.concat(got.stdout),
					stderr: Buffer.concat(got.stderr),
				};
			}
		}
		throw new Error("exec_output never got to done");
	}

	it("exec_run with 16 KiB of 0x01 and the default budget: the tail that fits, offsets as shown", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:fill 01:16384",
		});
		const shown = checkAnswer(r);
		expect(r.json.status).toBe("exited");
		expect(r.json.stdout).toMatchObject({ size: 16384, to: 16384 });
		expect(r.json.stdout.from).toBeGreaterThan(0);
		expect(
			shown.stdout.equals(Buffer.alloc(16384 - r.json.stdout.from, 1)),
		).toBe(true);
		expect(r.lines).toContain(
			`stdout: last ${16384 - r.json.stdout.from} of 16384 bytes.`,
		);
		const all = await readAll(hh, sb, r.json.command_id);
		expect(sha256(all.stdout)).toBe(sha256(Buffer.alloc(16384, 1)));
	});

	it("exec_run with 64 KiB of NUL on both streams: both fences closed, chained exec_output gives every byte", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:fill 00:65536:both",
			max_output_bytes: 65536,
		});
		const shown = checkAnswer(r);
		for (const s of STREAM_NAMES) {
			expect(r.json[s]).toMatchObject({ size: 65536, to: 65536 });
			expect(shown[s].length).toBeGreaterThan(0);
		}
		const all = await readAll(hh, sb, r.json.command_id);
		for (const s of STREAM_NAMES) {
			expect(sha256(all[s]), s).toBe(sha256(Buffer.alloc(65536, 0)));
		}
	});

	it("exec_output tail of 64 KiB of 0x01: the end of the stream that fits", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const r = await hh.call("exec_run", {
			sandbox: sb,
			command: "fake:fill 01:65536",
			max_output_bytes: 1024,
		});
		const t = await hh.call("exec_output", {
			sandbox: sb,
			command_id: r.json.command_id,
			max_bytes: 65536,
		});
		const shown = checkAnswer(t);
		expect(t.json.stdout).toMatchObject({ size: 65536, to: 65536 });
		expect(t.json.stdout.from).toBeGreaterThan(0);
		expect(
			shown.stdout.equals(Buffer.alloc(65536 - t.json.stdout.from, 1)),
		).toBe(true);
		expect(t.json.done).toBe(true);
	});
});

describe("a key with only the commands scopes", () => {
	it("runs, starts, reads (with a wait), lists and kills without reading the sandbox", async () => {
		const hh = await start({
			api: {
				tokens: {
					umiak_fake_commands: {
						kind: "team_key",
						scopes: ["commands:exec", "commands:read"],
						teamId: FAKE_TEAM,
						keyId: "key_fake_commands",
					},
				},
			},
			token: "umiak_fake_commands",
		});
		const admin = new Umiak({
			baseUrl: hh.api.url,
			apiKey: FAKE_TOKENS.full,
			env: {},
		});
		const created = await admin.sandboxes.create({ slug: "cmd-box" });
		await created.waitUntilReady();
		const sb = created.id;
		const run = await hh.call("exec_run", { sandbox: sb, command: "echo ok" });
		expect(run.isError, run.texts.join("\n")).toBe(false);
		expect(fenced(run, "stdout")).toBe("ok\n");
		// A slug works too: its key falls back to the slug (no sandboxes:read).
		const bySlug = await hh.call("exec_run", {
			sandbox: "cmd-box",
			command: "echo slug",
		});
		expect(bySlug.isError, bySlug.texts.join("\n")).toBe(false);
		const s = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
		});
		expect(s.isError, s.texts.join("\n")).toBe(false);
		const o = await hh.call("exec_output", {
			sandbox: sb,
			command_id: s.json.command_id,
			stdout_offset: 0,
			stderr_offset: 0,
			wait_seconds: 1,
		});
		expect(o.isError, o.texts.join("\n")).toBe(false);
		const l = await hh.call("exec_list", { sandbox: sb, status: "all" });
		expect(l.isError).toBe(false);
		const k = await hh.call("exec_kill", {
			sandbox: sb,
			command_id: s.json.command_id,
		});
		expect(k.isError, k.texts.join("\n")).toBe(false);
		// The only sandbox read of this key: the slug lookup (403, the slug stands).
		expect(
			hh.requests.filter(
				(q) =>
					q.method === "GET" &&
					/^\/v1\/sandboxes\/[^/]+$/.test(q.path) &&
					q.headers.get("authorization") === "Bearer umiak_fake_commands",
			),
		).toHaveLength(1);
	});
});

describe("exec_list and exec_kill", () => {
	it("exec_list asks for running commands by default and for all with status=all", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		await hh.call("exec_run", { sandbox: sb, command: "echo done" });
		const s = await hh.call("exec_start", {
			sandbox: sb,
			command: "fake:sleep 30",
		});
		const running = await hh.call("exec_list", { sandbox: sb });
		expect(running.json.count).toBe(1);
		expect(running.json.commands[0]).toMatchObject({
			id: s.json.command_id,
			status: "running",
			command: "fake:sleep 30",
		});
		const all = await hh.call("exec_list", {
			sandbox: sb,
			status: "all",
			limit: 1,
		});
		expect(all.json.count).toBe(1);
		expect(all.json.next_cursor).toEqual(expect.any(String));
		expect(all.lines).toContain("cursor=next_cursor");
		const gets = hh.to("GET", COMMANDS(sb));
		expect(gets[0]?.query.get("status")).toBe("running");
		expect(gets[0]?.query.get("limit")).toBe("20");
		expect(gets[1]?.query.has("status")).toBe(false);
	});

	it("exec_kill: SIGTERM is /kill with graceMs 10000, SIGINT and SIGKILL are /signal", async () => {
		const hh = await start();
		const sb = await sandbox(hh);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const s = await hh.call("exec_start", {
				sandbox: sb,
				command: "fake:sleep 30",
			});
			ids.push(s.json.command_id);
		}
		const term = await hh.call("exec_kill", {
			sandbox: sb,
			command_id: ids[0],
		});
		expect(term.json).toMatchObject({ command_id: ids[0], status: "killed" });
		expect(term.lines).toContain("SIGKILL");
		expect(hh.to("POST", `${COMMANDS(sb)}/${ids[0]}/kill`)[0]?.body).toEqual({
			graceMs: 10000,
		});
		await hh.call("exec_kill", {
			sandbox: sb,
			command_id: ids[1],
			signal: "SIGINT",
		});
		await hh.call("exec_kill", {
			sandbox: sb,
			command_id: ids[2],
			signal: "SIGKILL",
		});
		expect(hh.to("POST", `${COMMANDS(sb)}/${ids[1]}/signal`)[0]?.body).toEqual({
			signal: "SIGINT",
		});
		expect(hh.to("POST", `${COMMANDS(sb)}/${ids[2]}/signal`)[0]?.body).toEqual({
			signal: "SIGKILL",
		});
		expect(hh.api.journal.filter((l) => l.endsWith("/kill"))).toHaveLength(1);
	});
});
