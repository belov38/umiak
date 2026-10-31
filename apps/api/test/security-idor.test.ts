// IDOR matrix (S7 §7.5, Review Focus 2): for every operation that names a
// resource in its path or body, team A's credentials (a key with every
// scope and an owner's browser session) against team B's resource answer
// 404, the same as a resource that does not exist. That includes B's
// command, terminal and upload ids under A's own sandbox path, B's sandbox
// by slug, B's snapshot and environment in a create body, B's operation,
// environment, SSH key and API key. Afterwards every stored row of team B
// is unchanged and the agent was never called for B's machine.
import { newPublicUlid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type ApiDeps, PTY_SUBPROTOCOL } from "../src/index.ts";
import { issueApiKey } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import {
	type Fixture,
	ROUTE_LIST,
	type RouteRequest,
} from "./helpers/route-table.ts";
import {
	type AgentCall,
	type Any,
	buildFixture,
	errorOf,
	listen,
	newTeam,
	type Person,
	personOf,
	recordingAgent,
	send,
	type TeamFixture,
	teamState,
} from "./helpers/security.ts";
import { testSshCa } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

/** "Not yours" is "does not exist" (§5.5). */
const NOT_FOUND = ["not_found", "snapshot_not_found", "upload_not_found"];

interface Case {
	op: string;
	label: string;
	method: string;
	req: RouteRequest;
	human: boolean;
	websocket: boolean;
	/** Operator-only: everyone else is 403 operator_required, never 404. */
	operator: boolean;
	/**
	 * For ids that live in a sandbox (commands, terminals, uploads) used
	 * under A's sandbox: the same request with ids nobody ever issued. The
	 * answer must be the same (an upload id is a name in the sandbox's own
	 * namespace: a chunk at offset > 0 of an unknown upload is 409
	 * upload_offset_mismatch with offset 0, whoever made the id).
	 */
	unknown?: RouteRequest;
}

/** Requests of team A that name team B's resources. */
function cases(a: Fixture, b: TeamFixture): Case[] {
	const out: Case[] = [];
	for (const [op, r] of ROUTE_LIST) {
		const add = (label: string, req: RouteRequest, unknown?: RouteRequest) =>
			out.push({
				op,
				label,
				method: r.method,
				req,
				human: r.human === true,
				websocket: r.websocket === true,
				operator: r.operator === true,
				...(unknown === undefined ? {} : { unknown }),
			});
		if (r.bodyRefs) {
			for (const req of r.bodyRefs(b)) add("B's resource in the body", req);
			continue;
		}
		if (r.resources.length === 0) continue;
		add("B's resources", r.request(b));
		if (r.resources.includes("sandbox")) {
			add("B's sandbox by slug", r.request({ ...b, sandbox: b.slug }));
		}
		if (r.resources.includes("environment")) {
			add(
				"B's environment by name",
				r.request({ ...b, environment: b.environmentName }),
			);
		}
		const nested = r.resources.filter((x) =>
			["command", "pty", "upload"].includes(x),
		);
		if (nested.length > 0) {
			add(
				`B's ${nested.join(", ")} under A's sandbox`,
				r.request({
					...a,
					command: b.command,
					pty: b.pty,
					upload: b.upload,
					uploadOffset: b.uploadOffset,
				}),
				r.request({
					...a,
					command: newPublicUlid("command"),
					pty: newPublicUlid("command"),
					upload: newPublicUlid("upload"),
					uploadOffset: b.uploadOffset,
				}),
			);
		}
	}
	return out;
}

describe.skipIf(skipPg())("IDOR: team A against team B's resources", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let deps: Partial<ApiDeps>;
	let calls: AgentCall[];
	let hA: Harness;
	let hB: Harness;
	let ownerA: Person;
	let ownerB: Person;
	let a: TeamFixture;
	let b: TeamFixture;
	let before: Record<string, unknown>;
	let recordedForB = 0;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		const rec = recordingAgent(w.agent);
		calls = rec.calls;
		deps = { agent: rec.agent, sshCa: testSshCa() };
		hA = w.harness({ deps });
		ownerA = await personOf(w, w.teamId, "owner", deps);
		a = await buildFixture(w, w.teamId, hA, ownerA);

		const teamB = await newTeam(db.pool);
		const keyB = await issueApiKey(w.identity, { teamId: teamB });
		hB = w.harness({ bearer: keyB.secret, deps });
		ownerB = await personOf(w, teamB, "owner", deps);
		b = await buildFixture(w, teamB, hB, ownerB);
		before = await teamState(db.pool, teamB, [ownerB.userId]);
		// The recorder sees B's machine: building B's fixture went through it.
		recordedForB = calls.filter((c) => c.machineId === b.machineId).length;
		calls.length = 0;
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const answer = (r: HarnessResponse) => ({
		status: r.status,
		code: (r.body as Any)?.error?.code,
		details: (r.body as Any)?.error?.details,
	});

	/**
	 * 404 (or, for ids of a sandbox, the answer for ids never issued; for
	 * operator-only routes 403 operator_required, as for A's own resources).
	 */
	async function expectNotFound(
		c: Case,
		send: (req: RouteRequest) => Promise<HarnessResponse>,
		who: string,
	): Promise<void> {
		const r = await send(c.req);
		const where = `${who}: ${c.op} (${c.label}) ${c.method} ${c.req.path}`;
		if (c.operator) {
			// Refused before any lookup: the same for A's own resources.
			expect(answer(r), where).toEqual({
				status: 403,
				code: "forbidden",
				details: { reason: "operator_required" },
			});
			return;
		}
		if (c.unknown !== undefined) {
			const u = await send(c.unknown);
			expect(answer(r), `${where}: ${r.text.slice(0, 300)}`).toEqual(answer(u));
			if (r.status !== 404) {
				expect(answer(r), where).toEqual({
					status: 409,
					code: "upload_offset_mismatch",
					details: { offset: 0 },
				});
			}
			return;
		}
		expect(r.status, `${where}: ${r.text.slice(0, 300)}`).toBe(404);
		if (c.method !== "HEAD") {
			expect(NOT_FOUND, where).toContain(errorOf(r).code);
		}
	}

	it("the agent recorder saw B's machine while B's fixture was built", () => {
		expect(recordedForB).toBeGreaterThan(5);
	});

	it("covers every resource kind of the route table", () => {
		const named = new Set(ROUTE_LIST.flatMap(([, r]) => r.resources));
		expect([...named].sort()).toEqual([
			"apiKey",
			"command",
			"environment",
			"operation",
			"port",
			"pty",
			"sandbox",
			"snapshot",
			"sshKey",
			"upload",
		]);
		const ops = new Set(cases(a, b).map((c) => c.op));
		for (const [op, r] of ROUTE_LIST) {
			if (r.resources.length > 0) expect(ops, op).toContain(op);
		}
	});

	it("every request is 404 with a key of A (every scope) and with A's owner session", async () => {
		for (const c of cases(a, b)) {
			if (c.websocket) continue;
			if (!c.human) {
				await expectNotFound(c, (req) => send(hA, c.method, req), "key");
			}
			await expectNotFound(
				c,
				(req) => send(ownerA.h, c.method, req, ownerA.headers),
				"session",
			);
		}
	});

	it("a terminal connect is closed 4404 after the upgrade", async () => {
		const srv = await listen(hA.app);
		try {
			for (const c of cases(a, b).filter((x) => x.websocket)) {
				const ws = new WebSocket(
					`${srv.base}${c.req.path}`,
					[PTY_SUBPROTOCOL],
					{
						headers: { authorization: `Bearer ${w.secret}` },
					},
				);
				const texts: Any[] = [];
				ws.on("message", (data, binary) => {
					if (!binary) texts.push(JSON.parse(data.toString()));
				});
				ws.on("error", () => {});
				const code = await new Promise<number>((resolve) =>
					ws.once("close", (n) => resolve(n)),
				);
				expect(code, `${c.op} (${c.label})`).toBe(4404);
				expect(texts.at(-1)).toMatchObject({
					type: "error",
					code: "not_found",
				});
			}
		} finally {
			await srv.close();
		}
	});

	it("afterwards team B is unchanged and the agent never saw B's machine", async () => {
		expect(calls.filter((c) => c.machineId === b.machineId)).toEqual([]);
		expect(await teamState(db.pool, b.teamId, [ownerB.userId])).toEqual(before);
		// B still has its running command and terminal, its upload and files.
		const sb = `/v1/sandboxes/${b.sandbox}`;
		for (const id of [b.command, b.pty]) {
			const r = await hB.request("GET", `${sb}/commands/${id}`);
			expect((r.body as Any).status, id).toBe("running");
		}
		const offset = await hB.request("HEAD", `${sb}/files/uploads/${b.upload}`);
		expect(offset.headers.get("sbx-upload-offset")).toBe(
			String(b.uploadOffset),
		);
		for (const name of ["f.txt", "keep.txt"]) {
			const r = await hB.request("GET", `${sb}/files/content?path=~/${name}`);
			expect(r.text).toBe(`${name} of ${b.teamId}`);
		}
		const list = await hB.request("GET", `${sb}/files/list?path=~`);
		expect((list.body as Any).data.map((e: Any) => e.name).sort()).toEqual([
			"f.txt",
			"keep.txt",
		]);
	});
});
