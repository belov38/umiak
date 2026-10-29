// /stream options (tailBytes, follow=false), truncated output under the
// agent's retention, /output by offset with its headers, and the sync
// tail (collectSync).
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { collectSync, type Frame } from "../src/index.ts";
import {
	type Any,
	bytesOf,
	openStream,
	type ReadySandbox,
	readySandbox,
	sleep,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

async function* framesOf(list: Frame[]): AsyncGenerator<Frame> {
	yield* list;
}

describe("collectSync", () => {
	it("keeps the tail of each stream within the limit; From and Truncated follow it", async () => {
		const frames: Frame[] = [
			{ type: "stdout", offset: 0, nextOffset: 4, data: "abcd" },
			{ type: "stderr", offset: 0, nextOffset: 2, data: "xy" },
			{ type: "stdout", offset: 4, nextOffset: 8, data: "efgh" },
			{ type: "stdout", offset: 8, nextOffset: 10, data: "ij" },
			{
				type: "exit",
				status: "exited",
				exitCode: 0,
				signal: null,
				reason: "none",
				stdoutOffset: 10,
				stderrOffset: 2,
			},
		];
		const r = await collectSync(framesOf(frames), "utf8", 6);
		expect(r).toMatchObject({
			stdout: "efghij",
			stdoutFrom: 4,
			stdoutTruncated: true,
			stderr: "xy",
			stderrFrom: 0,
			stderrTruncated: false,
		});
		expect(r.exit?.type).toBe("exit");
		expect(r.ended).toBeNull();
	});

	it("truncated after kept output drops it: the answer starts at availableFrom", async () => {
		const frames: Frame[] = [
			{ type: "stdout", offset: 0, nextOffset: 3, data: "abc" },
			{ type: "truncated", stream: "stdout", availableFrom: 10 },
			{ type: "stdout", offset: 10, nextOffset: 13, data: "klm" },
			{
				type: "exit",
				status: "exited",
				exitCode: 0,
				signal: null,
				reason: "none",
				stdoutOffset: 13,
				stderrOffset: 0,
			},
		];
		const r = await collectSync(framesOf(frames), "utf8");
		expect(r).toMatchObject({
			stdout: "klm",
			stdoutFrom: 10,
			stdoutTruncated: true,
			stderr: "",
			stderrFrom: 0,
			stderrTruncated: false,
		});
	});

	it("base64 pieces are joined as bytes; truncated moves From", async () => {
		const frames: Frame[] = [
			{ type: "truncated", stream: "stdout", availableFrom: 100 },
			{
				type: "stdout",
				offset: 100,
				nextOffset: 101,
				data: Buffer.from([1]).toString("base64"),
			},
			{
				type: "stdout",
				offset: 101,
				nextOffset: 103,
				data: Buffer.from([2, 3]).toString("base64"),
			},
			{
				type: "error",
				code: "agent_unavailable",
				message: "x",
				retryable: true,
				requestId: "r",
				stdoutOffset: 103,
				stderrOffset: 0,
			},
		];
		const r = await collectSync(framesOf(frames), "base64");
		expect(Buffer.from(r.stdout, "base64")).toEqual(Buffer.from([1, 2, 3]));
		expect(r).toMatchObject({
			stdoutFrom: 100,
			stdoutTruncated: true,
			exit: null,
		});
		expect(r.ended?.type).toBe("error");
	});
});

describe.skipIf(skipPg())("attach and output", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
	});
	afterEach(() => w.agent.retention(null));
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	async function detached(command: string): Promise<string> {
		const r = await h.request("POST", sb.commands, {
			json: { command, mode: "detached" },
		});
		expect(r.status).toBe(201);
		return (r.body as Any).id;
	}

	async function exited(id: string): Promise<Any> {
		for (let i = 0; i < 100; i++) {
			const g = await h.request("GET", `${sb.commands}/${id}`);
			if ((g.body as Any).status !== "running") return g.body;
			await sleep(50);
		}
		throw new Error("command did not exit");
	}

	it("tailBytes starts each stream near its end; attached carries the start", async () => {
		const id = await detached("printf 0123456789; printf abcdef >&2");
		await exited(id);
		const s = await openStream(
			h,
			"GET",
			`${sb.commands}/${id}/stream?tailBytes=4`,
		);
		const frames = await s.rest();
		expect(frames[0]).toMatchObject({
			type: "attached",
			stdoutOffset: 6,
			stderrOffset: 2,
		});
		const b = bytesOf(frames, "utf8", { stdout: 6, stderr: 2 });
		expect(b.stdout.toString()).toBe("6789");
		expect(b.stderr.toString()).toBe("cdef");
		expect(frames.at(-1)).toMatchObject({
			type: "exit",
			stdoutOffset: 10,
			stderrOffset: 6,
		});
	});

	it("follow=false: what exists now, then the end (no exit while running)", async () => {
		const id = await detached("echo early; sleep 1; echo late");
		await sleep(200);
		const r = await h.request(
			"GET",
			`${sb.commands}/${id}/stream?follow=false`,
		);
		expect(r.status).toBe(200);
		const frames = r.body as Frame[];
		expect(frames.map((f) => f.type)).toEqual(["attached", "stdout"]);
		expect(frames[1]).toMatchObject({ data: "early\n", nextOffset: 6 });
		await exited(id);
		const done = await h.request(
			"GET",
			`${sb.commands}/${id}/stream?follow=false&stdoutOffset=6`,
		);
		const after = done.body as Frame[];
		expect(after.map((f) => f.type)).toEqual(["attached", "stdout", "exit"]);
		expect(after[1]).toMatchObject({ offset: 6, data: "late\n" });
	});

	it("an offset evicted by retention → truncated, then output from availableFrom", async () => {
		const id = await detached("printf '%s' 0123456789abcdefghij");
		await exited(id);
		w.agent.retention(5);
		const s = await openStream(h, "GET", `${sb.commands}/${id}/stream`);
		const frames = await s.rest();
		expect(frames.map((f) => f.type)).toEqual([
			"attached",
			"truncated",
			"stdout",
			"exit",
		]);
		expect(frames[1]).toEqual({
			type: "truncated",
			stream: "stdout",
			availableFrom: 15,
		});
		expect(frames[2]).toMatchObject({
			offset: 15,
			nextOffset: 20,
			data: "fghij",
		});
		const g = await h.request("GET", `${sb.commands}/${id}`);
		expect((g.body as Any).streams.stdout).toEqual({
			sizeBytes: 20,
			availableFromBytes: 15,
			endBytes: 20,
		});
	});

	it("/output: bytes from an offset with Sbx-* headers and the limit", async () => {
		const id = await detached("printf '%s' 0123456789; printf E >&2");
		await exited(id);
		const r = await h.request(
			"GET",
			`${sb.commands}/${id}/output?offset=3&limit=4`,
		);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("application/octet-stream");
		expect(r.text).toBe("3456");
		expect(r.headers.get("sbx-offset")).toBe("3");
		expect(r.headers.get("sbx-next-offset")).toBe("7");
		expect(r.headers.get("sbx-available-from")).toBe("0");
		expect(r.headers.get("sbx-stream-end")).toBe("10");
		expect(r.headers.get("sbx-truncated")).toBeNull();
		const err = await h.request(
			"GET",
			`${sb.commands}/${id}/output?stream=stderr`,
		);
		expect(err.text).toBe("E");
		const past = await h.request(
			"GET",
			`${sb.commands}/${id}/output?offset=10`,
		);
		expect(past.status).toBe(200);
		expect(past.text).toBe("");
		expect(past.headers.get("sbx-next-offset")).toBe("10");
		const beyond = await h.request(
			"GET",
			`${sb.commands}/${id}/output?offset=11`,
		);
		expect(beyond.status).toBe(416);
		expect((beyond.body as Any).error).toMatchObject({
			code: "range_not_satisfiable",
			details: { size: 10 },
		});
		const pty = await h.request(
			"GET",
			`${sb.commands}/${id}/output?stream=pty`,
		);
		expect(pty.status).toBe(400);
		const big = await h.request(
			"GET",
			`${sb.commands}/${id}/output?limit=${4 * 1024 * 1024 + 1}`,
		);
		expect(big.status).toBe(400);
	});

	it("/output with offset < availableFrom starts at availableFrom with Sbx-Truncated", async () => {
		const id = await detached("printf '%s' 0123456789");
		await exited(id);
		w.agent.retention(3);
		const r = await h.request("GET", `${sb.commands}/${id}/output?offset=2`);
		expect(r.text).toBe("789");
		expect(r.headers.get("sbx-truncated")).toBe("true");
		expect(r.headers.get("sbx-offset")).toBe("7");
		expect(r.headers.get("sbx-available-from")).toBe("7");
		expect(r.headers.get("sbx-next-offset")).toBe("10");
	});

	it("/output of a running command has no Sbx-Stream-End", async () => {
		const id = await detached("echo a; sleep 2");
		await sleep(150);
		const r = await h.request("GET", `${sb.commands}/${id}/output`);
		expect(r.text).toBe("a\n");
		expect(r.headers.get("sbx-stream-end")).toBeNull();
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 100 },
		});
	});

	it("output of a stopped sandbox is 409 sandbox_not_ready; list and get still work", async () => {
		const s = await readySandbox(w);
		const r = await h.request("POST", s.commands, {
			json: { command: "echo x" },
		});
		const id = (r.body as Any).command.id;
		await w.markState(s.sandboxId, "stopped");
		for (const path of [
			`${s.commands}/${id}/output`,
			`${s.commands}/${id}/stream`,
		]) {
			const x = await h.request("GET", path);
			expect(x.status, path).toBe(409);
			expect((x.body as Any).error).toMatchObject({
				code: "sandbox_not_ready",
				details: { state: "stopped" },
			});
		}
		const g = await h.request("GET", `${s.commands}/${id}`);
		expect(g.status).toBe(200);
		expect(g.body).toMatchObject({
			status: "exited",
			streams: {
				stdout: { sizeBytes: 2, availableFromBytes: null, endBytes: 2 },
			},
		});
		const l = await h.request("GET", s.commands);
		expect((l.body as Any).data.map((c: Any) => c.id)).toEqual([id]);
	});
});
