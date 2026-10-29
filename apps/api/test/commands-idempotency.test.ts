// POST /commands with Idempotency-Key (S7 §5.7, §9.3, Review Focus 1): a
// repeat while the first request waits for Start or streams, and after it
// ended, attaches to the same command; the agent runs it once. A Start
// whose outcome is unknown is 503 agent_unavailable, retryable only with a
// key.
import { AgentUnavailableError } from "@sbx/agent-client";
import { uuidv5 } from "@sbx/core";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentApi } from "../src/index.ts";
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

describe.skipIf(skipPg())("Idempotency-Key on POST /commands", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;
	let realStart: AgentApi["start"];
	const requestIds: string[] = [];

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
		realStart = w.agent.start.bind(w.agent);
		w.agent.start = (m, req, opts) => {
			requestIds.push(opts.requestId);
			return realStart(m, req, opts);
		};
	});
	afterEach(() => {
		requestIds.length = 0;
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const key = () => `k-${Math.random().toString(36).slice(2)}`;
	const internalId = (pub: string) => pub.slice(4).toUpperCase();

	it("a repeat while the first streams: the same command from offset 0, replayed, one Start", async () => {
		const k = key();
		const body = {
			mode: "stream",
			command: "for i in 1 2 3 4 5; do echo line$i; sleep 0.1; done",
		};
		const first = await openStream(h, "POST", sb.commands, {
			json: body,
			headers: { "idempotency-key": k },
		});
		const started = (await first.next()) as Any;
		expect(started).toMatchObject({ type: "started" });
		expect(started.replayed).toBeUndefined();
		await first.until((f) => f.type === "stdout");

		const second = await openStream(h, "POST", sb.commands, {
			json: body,
			headers: { "idempotency-key": k },
		});
		expect(second.status).toBe(200);
		expect(second.headers.get("idempotency-replayed")).toBe("true");
		const frames = await second.rest();
		expect(frames[0]).toMatchObject({
			type: "started",
			commandId: started.commandId,
			replayed: true,
		});
		expect(frames.find((f) => f.type === "stdout")).toMatchObject({
			offset: 0,
		});
		expect(bytesOf(frames).stdout.toString()).toBe(
			"line1\nline2\nline3\nline4\nline5\n",
		);
		expect(frames.at(-1)).toMatchObject({ type: "exit", status: "exited" });
		const rest = await first.rest();
		expect(rest.at(-1)?.type).toBe("exit");

		// And after it ended: the same again, the stored output from 0.
		const third = await h.request("POST", sb.commands, {
			json: body,
			headers: { "idempotency-key": k },
		});
		expect(third.status).toBe(200);
		const f3 = third.body as Any[];
		expect(f3[0]).toMatchObject({
			commandId: started.commandId,
			replayed: true,
		});
		expect(f3.at(-1)).toMatchObject({ type: "exit", stdoutOffset: 30 });

		expect(
			w.agent.startCount(internalId(started.commandId), sb.machineId),
		).toBe(1);
		const p = uuidv5(`${w.keyId}:commands.create:${k}`);
		// The ended replay did not call Start again.
		expect(requestIds).toEqual([p, p]);
	});

	it("concurrent requests while Start is slow: one command, one launch", async () => {
		const k = key();
		w.agent.start = async (m, req, opts) => {
			requestIds.push(opts.requestId);
			await sleep(300);
			return realStart(m, req, opts);
		};
		try {
			const body = { mode: "stream", command: "echo once" };
			const [a, b] = await Promise.all([
				h.request("POST", sb.commands, {
					json: body,
					headers: { "idempotency-key": k },
				}),
				h.request("POST", sb.commands, {
					json: body,
					headers: { "idempotency-key": k },
				}),
			]);
			expect([a.status, b.status]).toEqual([200, 200]);
			const fa = a.body as Any[];
			const fb = b.body as Any[];
			expect(fa[0].commandId).toBe(fb[0].commandId);
			expect([fa[0].replayed, fb[0].replayed].filter(Boolean)).toEqual([true]);
			for (const f of [fa, fb]) {
				expect(bytesOf(f).stdout.toString()).toBe("once\n");
				expect(f.at(-1).type).toBe("exit");
			}
			expect(
				w.agent.startCount(internalId(fa[0].commandId), sb.machineId),
			).toBe(1);
		} finally {
			w.agent.start = (m, req, opts) => {
				requestIds.push(opts.requestId);
				return realStart(m, req, opts);
			};
		}
	});

	it("sync repeat waits for the same command; detached repeat answers 200", async () => {
		const k = key();
		const body = { command: "echo sync; sleep 0.2" };
		const [a, b] = await Promise.all([
			h.request("POST", sb.commands, {
				json: body,
				headers: { "idempotency-key": k },
			}),
			(async () => {
				await sleep(100);
				return h.request("POST", sb.commands, {
					json: body,
					headers: { "idempotency-key": k },
				});
			})(),
		]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect((a.body as Any).command.id).toBe((b.body as Any).command.id);
		expect((b.body as Any).stdout).toBe("sync\n");
		expect(b.headers.get("idempotency-replayed")).toBe("true");
		expect(w.agent.startCount(internalId((a.body as Any).command.id))).toBe(1);

		const dk = key();
		const d1 = await h.request("POST", sb.commands, {
			json: { command: "sleep 1", mode: "detached" },
			headers: { "idempotency-key": dk },
		});
		const d2 = await h.request("POST", sb.commands, {
			json: { command: "sleep 1", mode: "detached" },
			headers: { "idempotency-key": dk },
		});
		expect([d1.status, d2.status]).toEqual([201, 200]);
		expect((d2.body as Any).id).toBe((d1.body as Any).id);
		expect(d2.headers.get("idempotency-replayed")).toBe("true");
		expect(w.agent.startCount(internalId((d1.body as Any).id))).toBe(1);
	});

	it("the same key with another body is 409 idempotency_key_reused", async () => {
		const k = key();
		const a = await h.request("POST", sb.commands, {
			json: { command: "true", mode: "detached" },
			headers: { "idempotency-key": k },
		});
		expect(a.status).toBe(201);
		const b = await h.request("POST", sb.commands, {
			json: { command: "false", mode: "detached" },
			headers: { "idempotency-key": k },
		});
		expect(b.status).toBe(409);
		expect((b.body as Any).error.code).toBe("idempotency_key_reused");
		const other = await readySandbox(w);
		const c = await h.request("POST", other.commands, {
			json: { command: "true", mode: "detached" },
			headers: { "idempotency-key": k },
		});
		expect(c.status).toBe(409);
	});

	describe("Start with an unknown outcome (agent_unavailable)", () => {
		const failOnce = () => {
			let failed = false;
			w.agent.start = async (m, req, opts) => {
				requestIds.push(opts.requestId);
				if (!failed) {
					failed = true;
					throw new AgentUnavailableError(m);
				}
				return realStart(m, req, opts);
			};
		};

		it("without a key: 503, retryable false, details {commandId, outcome: unknown}", async () => {
			failOnce();
			const r = await h.request("POST", sb.commands, {
				json: { command: "echo nokey", mode: "stream" },
			});
			expect(r.status).toBe(503);
			const e = (r.body as Any).error;
			expect(e).toMatchObject({
				code: "agent_unavailable",
				retryable: false,
				details: { outcome: "unknown" },
			});
			expect(e.details.commandId).toMatch(/^cmd_/);
			const g = await h.request("GET", `${sb.commands}/${e.details.commandId}`);
			expect(g.status).toBe(200);
			expect((g.body as Any).status).toBe("starting");
			// Another request without a key is another command (new requestId).
			const r2 = await h.request("POST", sb.commands, {
				json: { command: "echo nokey", mode: "detached" },
			});
			expect(r2.status).toBe(201);
			expect((r2.body as Any).id).not.toBe(e.details.commandId);
			expect(requestIds[0]).not.toBe(requestIds[1]);
		});

		it("with a key: 503 retryable; the retry starts it exactly once", async () => {
			failOnce();
			const k = key();
			const body = { command: "echo keyed", mode: "stream" };
			const r = await h.request("POST", sb.commands, {
				json: body,
				headers: { "idempotency-key": k },
			});
			expect(r.status).toBe(503);
			const e = (r.body as Any).error;
			expect(e).toMatchObject({ code: "agent_unavailable", retryable: true });
			expect(e.details.outcome).toBeUndefined();
			expect(r.headers.get("retry-after")).toEqual(expect.any(String));
			const again = await h.request("POST", sb.commands, {
				json: body,
				headers: { "idempotency-key": k },
			});
			expect(again.status).toBe(200);
			const frames = again.body as Any[];
			expect(frames[0]).toMatchObject({
				commandId: e.details.commandId,
				replayed: true,
			});
			expect(bytesOf(frames).stdout.toString()).toBe("keyed\n");
			expect(w.agent.startCount(internalId(e.details.commandId))).toBe(1);
			expect(requestIds[0]).toBe(requestIds[1]);
		});
	});
});
