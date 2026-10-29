// StreamRegistry (S7 §5.8, §7.10, S8 C9, Review Focus 4): open streams of
// a principal are capped, closed with `error unauthorized` within a second
// of the NOTIFY sbx_identity that revokes the principal, and closed with
// `reconnect server_shutdown` by closeAll.
import { randomUUID } from "node:crypto";
import { PgIdentityStore } from "@sbx/auth";
import { pgIdentitySeeding } from "@sbx/auth/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CloseFrame,
	type IdentityChange,
	IdentityListener,
	StreamRegistry,
} from "../src/index.ts";
import { captureLogs, testSettings } from "../src/testing/index.ts";
import {
	type Any,
	openStream,
	type ReadySandbox,
	readySandbox,
	sleep,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

function must<T>(v: T | undefined): T {
	if (v === undefined) throw new Error("missing");
	return v;
}

/** An identity store and event source under the test's control. */
function stubs() {
	const handlers = new Set<(c: IdentityChange) => void>();
	const state = {
		keys: new Map<
			string,
			{ id: string; teamId: string; revoked: boolean; expiresAt: Date }
		>(),
		users: new Map<string, { active: boolean; isOperator: boolean }>(),
		members: new Set<string>(),
		fail: false,
		calls: 0,
	};
	const check = () => {
		state.calls++;
		if (state.fail) throw new Error("store down");
	};
	const identity = {
		async findApiKeyByHash(h: string) {
			check();
			const k = state.keys.get(h);
			return k === undefined
				? null
				: ({ ...k, revokedAt: k.revoked ? new Date() : null } as Any);
		},
		async user(id: string) {
			check();
			const u = state.users.get(id);
			return u === undefined ? null : ({ id, ...u } as Any);
		},
		async membership(userId: string, teamId: string) {
			check();
			return state.members.has(`${userId}:${teamId}`)
				? { role: "member" as const }
				: null;
		},
	};
	const events = {
		subscribe(fn: (c: IdentityChange) => void) {
			handlers.add(fn);
			return () => void handlers.delete(fn);
		},
	};
	const emit = async (c: IdentityChange) => {
		for (const fn of handlers) fn(c);
		await sleep(20);
	};
	return { identity, events, state, emit };
}

describe("StreamRegistry", () => {
	it("caps open connections per principal; unregister frees the slot", () => {
		const { identity, events } = stubs();
		const r = new StreamRegistry({ identity, events, maxPerPrincipal: 2 });
		const owner = { userId: null, apiKeyId: "k1", teamId: "t" };
		const u1 = r.register(owner, () => {});
		r.register(owner, () => {});
		expect(() => r.register(owner, () => {})).toThrow(
			expect.objectContaining({
				status: 429,
				code: "rate_limited",
				retryable: true,
			}),
		);
		// Another principal has its own budget.
		r.register({ userId: "u", apiKeyId: null, teamId: "t" }, () => {});
		u1();
		u1();
		expect(r.count("k1")).toBe(1);
		r.register(owner, () => {});
		expect(r.size).toBe(3);
		// Uncapped (sync) connections are tracked but not counted.
		const sync = r.register(owner, () => {}, { capped: false });
		expect(r.count("k1")).toBe(2);
		expect(r.size).toBe(4);
		expect(r.revoke({ apiKeyId: "k1" })).toBe(3);
		sync();
		expect(r.count("k1")).toBe(2);
		expect(r.size).toBe(3);
	});

	it("re-checks only the affected principals and closes those that fail", async () => {
		const { identity, events, state, emit } = stubs();
		const r = new StreamRegistry({ identity, events, maxPerPrincipal: 10 });
		state.keys.set("h1", {
			id: "k1",
			teamId: "t",
			revoked: false,
			expiresAt: new Date(Date.now() + 60_000),
		});
		state.keys.set("h2", {
			id: "k2",
			teamId: "t",
			revoked: false,
			expiresAt: new Date(Date.now() + 60_000),
		});
		state.users.set("u1", { active: true, isOperator: false });
		state.users.set("op", { active: true, isOperator: true });
		state.members.add("u1:t");
		const closed: Record<string, CloseFrame[]> = {};
		const reg = (name: string, o: Any) =>
			r.register(o, (f) => {
				const list = closed[name] ?? [];
				list.push(f);
				closed[name] = list;
			});
		reg("k1", { userId: null, apiKeyId: "k1", teamId: "t", apiKeyHash: "h1" });
		reg("k2", { userId: null, apiKeyId: "k2", teamId: "t", apiKeyHash: "h2" });
		reg("u1", { userId: "u1", apiKeyId: null, teamId: "t" });
		reg("op", {
			userId: "op",
			apiKeyId: null,
			teamId: "other",
			operator: true,
		});

		await emit({ all: false, collection: "ssh-keys", id: "x" });
		expect(state.calls).toBe(0);

		must(state.keys.get("h1")).revoked = true;
		await emit({ all: false, collection: "api-keys", id: "k1" });
		expect(closed.k1).toEqual([
			expect.objectContaining({
				type: "error",
				code: "unauthorized",
				retryable: false,
			}),
		]);
		expect(closed.k2).toBeUndefined();

		// A failing store keeps the connections.
		state.members.delete("u1:t");
		state.fail = true;
		await emit({ all: false, collection: "memberships", id: "u1:t" });
		expect(closed.u1).toBeUndefined();
		state.fail = false;
		await emit({ all: false, collection: "memberships", id: "u1:t" });
		expect(closed.u1).toHaveLength(1);

		// An operator outside the team passes while active and an operator.
		await emit({ all: true });
		expect(closed.op).toBeUndefined();
		must(state.users.get("op")).isOperator = false;
		await emit({ all: false, collection: "users", id: "op" });
		expect(closed.op).toHaveLength(1);

		// Expired key, '*': closes k2; abort is called once per connection.
		must(state.keys.get("h2")).expiresAt = new Date(Date.now() - 1);
		await emit({ all: true });
		await emit({ all: true });
		expect(closed.k2).toHaveLength(1);
		expect(closed.k1).toHaveLength(1);
	});

	it("revoke(match) and closeAll: reconnect frames, then new streams are refused", async () => {
		const { identity, events } = stubs();
		const r = new StreamRegistry({ identity, events, maxPerPrincipal: 10 });
		const frames: CloseFrame[] = [];
		const unA = r.register({ userId: "a", apiKeyId: null, teamId: "t" }, (f) =>
			frames.push(f),
		);
		const unB = r.register({ userId: "b", apiKeyId: null, teamId: "t" }, (f) =>
			frames.push(f),
		);
		expect(r.revoke({ userId: "a" })).toBe(1);
		expect(frames).toEqual([expect.objectContaining({ code: "unauthorized" })]);
		unA();
		const done = r.closeAll("server_shutdown", 5000);
		expect(frames.at(-1)).toEqual({
			type: "reconnect",
			reason: "server_shutdown",
		});
		let resolved = false;
		void done.then(() => {
			resolved = true;
		});
		await sleep(20);
		expect(resolved).toBe(false);
		unB();
		await done;
		expect(() =>
			r.register({ userId: "c", apiKeyId: null, teamId: "t" }, () => {}),
		).toThrow(
			expect.objectContaining({ status: 503, code: "server_shutting_down" }),
		);
	});
});

describe.skipIf(skipPg())("stream registry over HTTP and NOTIFY", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let events: IdentityListener;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		events = IdentityListener.connect(db.url, { reconnectDelayMs: 50 });
		events.start();
		await events.whenReady();
		h = w.harness({ deps: { identityEvents: events } });
		sb = await readySandbox(w);
	});
	afterAll(async () => {
		await events?.close();
		await w?.close();
		await db?.drop();
	});

	it("a key revoked during an open stream: error unauthorized within 1 s; the command keeps running", async () => {
		const k = await w.key(["commands:exec", "commands:read"]);
		const s = await openStream(h, "POST", sb.commands, {
			json: { mode: "stream", command: "echo hi; sleep 5" },
			bearer: k.secret,
		});
		expect(s.status).toBe(200);
		await s.until((f) => f.type === "stdout");
		const other = await openStream(h, "POST", sb.commands, {
			json: { mode: "stream", command: "sleep 3" },
		});
		await other.next();

		const t0 = Date.now();
		await w.identity.revokeApiKey(k.id, {});
		const last = (await s.until((f) => f.type === "error", 2000)) as Any;
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(last).toMatchObject({
			type: "error",
			code: "unauthorized",
			retryable: false,
			stdoutOffset: 3,
			stderrOffset: 0,
		});
		expect(await s.next()).toBeNull();
		const id = (s.frames[0] as Any).commandId;
		const g = await h.request("GET", `${sb.commands}/${id}`);
		expect((g.body as Any).status).toBe("running");
		// The other key's stream is untouched.
		expect(h.deps.streams.size).toBe(1);
		const again = await h.request("GET", `${sb.commands}/${id}/stream`, {
			headers: { authorization: `Bearer ${k.secret}` },
		});
		expect(again.status).toBe(401);
		await other.cancel();
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("a sync request whose key is revoked meanwhile is 401", async () => {
		const k = await w.key(["commands:exec", "commands:read"]);
		const pending = h.request("POST", sb.commands, {
			json: { command: "sleep 3" },
			headers: { authorization: `Bearer ${k.secret}` },
		});
		await sleep(300);
		await w.identity.revokeApiKey(k.id, {});
		const r = await pending;
		expect(r.status).toBe(401);
		expect((r.body as Any).error.code).toBe("unauthorized");
	});

	it("a member removed or a user deactivated: their registered streams close within 1 s", async () => {
		const seed = pgIdentitySeeding(db.pool);
		const store = new PgIdentityStore({ pool: db.pool, operatorGroups: [] });
		const reg = new StreamRegistry({
			identity: store,
			events,
			maxPerPrincipal: 10,
		});
		try {
			const team = await seed.seedTeam(`t-${randomUUID()}`);
			const u1 = await seed.seedUser({ email: `${randomUUID()}@e.x` });
			const u2 = await seed.seedUser({ email: `${randomUUID()}@e.x` });
			await seed.addMember(u1, team, "member");
			await seed.addMember(u2, team, "owner");
			const closedAt: Record<string, number> = {};
			reg.register({ userId: u1, apiKeyId: null, teamId: team }, () => {
				closedAt.u1 = Date.now();
			});
			reg.register({ userId: u2, apiKeyId: null, teamId: team }, () => {
				closedAt.u2 = Date.now();
			});
			let t0 = Date.now();
			await seed.removeMember(u1, team);
			for (let i = 0; i < 50 && closedAt.u1 === undefined; i++) await sleep(20);
			expect(must(closedAt.u1) - t0).toBeLessThan(1000);
			expect(closedAt.u2).toBeUndefined();
			t0 = Date.now();
			await seed.setActive(u2, false);
			for (let i = 0; i < 50 && closedAt.u2 === undefined; i++) await sleep(20);
			expect(must(closedAt.u2) - t0).toBeLessThan(1000);
		} finally {
			reg.close();
		}
	});

	it("at most SBX_API_MAX_STREAMS open streams per key: 429 before anything starts", async () => {
		const k = await w.key(["commands:exec", "commands:read"]);
		const capped = w.harness({
			bearer: k.secret,
			deps: {
				settings: testSettings({
					SBX_API_RATE_BURST: "100000",
					SBX_API_MAX_STREAMS: "2",
				}),
			},
		});
		const a = await openStream(capped, "POST", sb.commands, {
			json: { mode: "stream", command: "sleep 3" },
		});
		const b = await openStream(capped, "POST", sb.commands, {
			json: { mode: "stream", command: "sleep 3" },
		});
		await a.next();
		await b.next();
		const before = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.commands",
		);
		const c = await capped.request("POST", sb.commands, {
			json: { mode: "stream", command: "sleep 3" },
		});
		expect(c.status).toBe(429);
		expect((c.body as Any).error).toMatchObject({
			code: "rate_limited",
			retryable: true,
		});
		const id = (a.frames[0] as Any).commandId;
		const d = await capped.request("GET", `${sb.commands}/${id}/stream`);
		expect(d.status).toBe(429);
		const after = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.commands",
		);
		expect(after.rows[0].n).toBe(before.rows[0].n);
		// Sync requests are not capped.
		const sync = await capped.request("POST", sb.commands, {
			json: { command: "echo sync" },
		});
		expect(sync.status).toBe(200);
		expect((sync.body as Any).stdout).toBe("sync\n");
		await a.cancel();
		await sleep(50);
		const e = await openStream(
			capped,
			"GET",
			`${sb.commands}/${id}/stream?follow=false`,
		);
		expect(e.status).toBe(200);
		await e.rest();
		await b.cancel();
		for (const f of [a, b]) {
			const cid = (f.frames[0] as Any).commandId;
			await h.request("POST", `${sb.commands}/${cid}/kill`, {
				json: { graceMs: 0 },
			});
		}
	});

	it("a stream whose request is aborted before its body is read frees the slot", async () => {
		const ac = new AbortController();
		const res = await h.app.request(sb.commands, {
			method: "POST",
			headers: {
				authorization: `Bearer ${w.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ mode: "stream", command: "sleep 2" }),
			signal: ac.signal,
		});
		expect(res.status).toBe(200);
		const id = res.headers.get("sbx-command-id");
		expect(h.deps.streams.size).toBe(1);
		ac.abort();
		await sleep(20);
		expect(h.deps.streams.size).toBe(0);
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("a sync client that goes away gets no agent_error; the command keeps running", async () => {
		const logs = captureLogs();
		const quiet = w.harness({
			deps: { log: logs.log, identityEvents: events },
		});
		const ac = new AbortController();
		const pending = quiet.app.request(sb.commands, {
			method: "POST",
			headers: {
				authorization: `Bearer ${w.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ command: "sleep 1; echo late" }),
			signal: ac.signal,
		});
		await sleep(300);
		ac.abort();
		const res = await pending;
		expect(res.status).toBe(499);
		expect(logs.text()).not.toContain("agent_error");
		expect(quiet.deps.streams.size).toBe(0);
		const list = await h.request("GET", `${sb.commands}?status=running`);
		expect((list.body as Any).data.length).toBeGreaterThan(0);
	});

	it("closeAll: open streams end with reconnect server_shutdown; sync gets 503 server_shutting_down", async () => {
		const shut = w.harness({ deps: { identityEvents: events } });
		const s = await openStream(shut, "POST", sb.commands, {
			json: { mode: "stream", command: "echo a; sleep 3" },
		});
		await s.until((f) => f.type === "stdout");
		const keyed = shut.request("POST", sb.commands, {
			json: { command: "sleep 3" },
			headers: { "idempotency-key": `k-${randomUUID()}` },
		});
		const plain = shut.request("POST", sb.commands, {
			json: { command: "sleep 3" },
		});
		await sleep(300);
		const closing = shut.deps.streams.closeAll("server_shutdown", 5000);
		const last = (await s.until((f) => f.type === "reconnect")) as Any;
		expect(last).toMatchObject({
			reason: "server_shutdown",
			stdoutOffset: 2,
			stderrOffset: 0,
		});
		const [k, p] = await Promise.all([keyed, plain]);
		expect(k.status).toBe(503);
		expect((k.body as Any).error).toMatchObject({
			code: "server_shutting_down",
			retryable: true,
		});
		expect(p.status).toBe(503);
		expect((p.body as Any).error).toMatchObject({
			code: "server_shutting_down",
			retryable: false,
			details: { outcome: "running" },
		});
		expect((p.body as Any).error.details.commandId).toMatch(/^cmd_/);
		await closing;
		expect(shut.deps.streams.size).toBe(0);
		const refused = await shut.request("POST", sb.commands, {
			json: { mode: "stream", command: "true" },
		});
		expect(refused.status).toBe(503);
		expect((refused.body as Any).error.code).toBe("server_shutting_down");
	});
});
