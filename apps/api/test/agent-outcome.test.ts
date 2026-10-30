// "Unknown outcome" of agent calls through the routes (S7 §5.5): a mutation
// without an idempotency key that ends with DeadlineExceeded (or an
// unreachable agent) answers 503 agent_unavailable with retryable false and
// details.outcome "unknown"; idempotent calls and reads stay retryable.
import { Code, ConnectError } from "@connectrpc/connect";
import { AgentUnavailableError } from "@sbx/agent-client";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentApi } from "../src/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
} from "./helpers/commands.ts";
import { filesUrl, qs } from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

type Fault = "deadline" | "unavailable";

describe.skipIf(skipPg())("unknown outcome of agent calls", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;
	/** AgentApi method → the fault its next calls throw. */
	const faults = new Map<string, Fault>();

	const thrown = (f: Fault, machineId: string) =>
		f === "deadline"
			? new ConnectError("the operation timed out", Code.DeadlineExceeded)
			: new AgentUnavailableError(machineId);

	/** The FakeAgent with `faults` applied (methods bound to the target). */
	function faulty(a: AgentApi): AgentApi {
		return new Proxy(a, {
			get(t, p) {
				const v = Reflect.get(t, p, t);
				if (typeof v !== "function") return v;
				return (...args: unknown[]) => {
					const f = faults.get(String(p));
					if (f !== undefined) {
						return Promise.reject(thrown(f, String(args[0])));
					}
					return v.apply(t, args);
				};
			},
		});
	}

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness({ deps: { agent: faulty(w.agent) } });
		sb = await readySandbox(w);
	});
	afterEach(() => faults.clear());
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const files = (rest: string, q: Record<string, string> = {}) =>
		filesUrl(sb.ref, `${rest}${Object.keys(q).length ? qs(q) : ""}`);

	const expectUnknown = (r: { status: number; body: unknown }) => {
		expect(r.status, JSON.stringify(r.body)).toBe(503);
		expect((r.body as Any).error).toMatchObject({
			code: "agent_unavailable",
			retryable: false,
			details: { outcome: "unknown" },
		});
	};
	const expectRetryable = (r: { status: number; body: unknown }) => {
		expect(r.status, JSON.stringify(r.body)).toBe(503);
		const e = (r.body as Any).error;
		expect(e).toMatchObject({ code: "agent_unavailable", retryable: true });
		expect(e.details.outcome).toBeUndefined();
	};

	describe.each<Fault>(["deadline", "unavailable"])("%s", (fault) => {
		it("file mutations: mkdir, move, chmod, delete are unknown outcomes", async () => {
			const cases: [
				string,
				() => Promise<{ status: number; body: unknown }>,
			][] = [
				[
					"makeDir",
					() => h.request("POST", files("/mkdir"), { json: { path: "d" } }),
				],
				[
					"move",
					() =>
						h.request("POST", files("/move"), {
							json: { from: "a", to: "b" },
						}),
				],
				[
					"chmod",
					() =>
						h.request("POST", files("/chmod"), {
							json: { path: "a", mode: 0o600 },
						}),
				],
				["remove", () => h.request("DELETE", files("", { path: "a" }))],
			];
			for (const [method, call] of cases) {
				faults.set(method, fault);
				const r = await call();
				expectUnknown(r);
				expect((r.body as Any).error.details.path).toBeDefined();
				faults.clear();
			}
		});

		it("file reads: stat and list stay retryable", async () => {
			faults.set("stat", fault);
			expectRetryable(await h.request("GET", files("/stat", { path: "~" })));
			faults.set("list", fault);
			expectRetryable(await h.request("GET", files("/list", { path: "~" })));
		});

		it("commands: input without a session and signal are unknown; input with a session, kill and get stay retryable", async () => {
			const st = await h.request("POST", sb.commands, {
				json: { command: "cat", mode: "detached", stdin: true },
			});
			expect(st.status).toBe(201);
			const id = (st.body as Any).id as string;
			try {
				faults.set("sendInput", fault);
				const noSession = await h.request(
					"POST",
					`${sb.commands}/${id}/input`,
					{ json: { data: "x" } },
				);
				expectUnknown(noSession);
				expect((noSession.body as Any).error.details.commandId).toBe(id);
				expectRetryable(
					await h.request("POST", `${sb.commands}/${id}/input`, {
						json: { data: "x", sessionId: "s1", seq: 1 },
					}),
				);
				faults.set("signal", fault);
				expectUnknown(
					await h.request("POST", `${sb.commands}/${id}/signal`, {
						json: { signal: "SIGINT" },
					}),
				);
				faults.set("kill", fault);
				expectRetryable(
					await h.request("POST", `${sb.commands}/${id}/kill`, {
						json: { graceMs: 0 },
					}),
				);
				faults.set("get", fault);
				expectRetryable(await h.request("GET", `${sb.commands}/${id}/output`));
			} finally {
				faults.clear();
				await h.request("POST", `${sb.commands}/${id}/kill`, {
					json: { graceMs: 0 },
				});
			}
		});

		it("start: unknown without a key, retryable with one", async () => {
			faults.set("start", fault);
			expectUnknown(
				await h.request("POST", sb.commands, {
					json: { command: "true", mode: "detached" },
				}),
			);
			expectRetryable(
				await h.request("POST", sb.commands, {
					json: { command: "true", mode: "detached" },
					headers: { "idempotency-key": `k-${fault}` },
				}),
			);
		});

		it("env: updateEnv and updateSecrets that fail leave delivered false (the stored sets are delivered later)", async () => {
			for (const method of ["updateEnv", "updateSecrets"]) {
				faults.set(method, fault);
				const r = await h.request("PUT", `/v1/sandboxes/${sb.ref}/env`, {
					json: { env: { A: "1" }, secrets: { S: "x" } },
				});
				expect(r.status).toBe(200);
				expect((r.body as Any).delivered).toBe(false);
				faults.clear();
			}
		});
	});
});
