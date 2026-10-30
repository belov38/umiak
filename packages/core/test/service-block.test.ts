// Operator blocks (S8 §17.1 C3, §17.2 S4): block/unblock of a sandbox and of
// a hosted port, the actions a block forbids for everyone but an operator,
// the routes the gateway gets, and the all-teams list of operators.
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	lookupRoute,
	type Principal,
	type SandboxServiceImpl,
	SCOPES,
} from "../src/index.ts";
import {
	expectCode,
	principal,
	type ServiceEnv,
	sandboxRow,
	seedSandbox,
	serviceEnv,
} from "./helpers/service.ts";

/** A browser session of a platform operator, in some other team. */
function operator(teamId: string = randomUUID()): Principal {
	return {
		kind: "session",
		userId: randomUUID(),
		teamId,
		role: null,
		isOperator: true,
		scopes: [...SCOPES],
	};
}

/** A non-operator browser session (owner) of the team. */
function owner(teamId: string): Principal {
	return {
		kind: "session",
		userId: randomUUID(),
		teamId,
		role: "owner",
		isOperator: false,
		scopes: [...SCOPES],
	};
}

async function events(q: pg.Pool, sandboxId: string, type: string) {
	const r = await q.query(
		`SELECT reason, data FROM runtime.sandbox_events
		 WHERE sandbox_id = $1 AND type = $2 ORDER BY created_at, id`,
		[sandboxId, type],
	);
	return r.rows;
}

async function expectForbidden(
	promise: Promise<unknown>,
	reason: string,
): Promise<void> {
	const err = await expectCode(promise, "forbidden");
	expect(err.details).toMatchObject({ reason });
	expect(err.retryable).toBe(false);
}

describe.skipIf(skipPg())("operator blocks (S8 C3)", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	describe("block / unblock a sandbox", () => {
		it("only an operator's browser session: keys, JWT and owners are forbidden, nothing changes", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const forged: Principal = { ...operator(env.p.teamId), kind: "oidc" };
			const key: Principal = { ...env.p, isOperator: true };
			for (const p of [env.p, key, forged, owner(env.p.teamId)]) {
				await expectForbidden(
					env.svc.block(p, s.sandboxId, { reason: "abuse" }),
					"operator_required",
				);
				await expectForbidden(
					env.svc.unblock(p, s.sandboxId),
					"operator_required",
				);
			}
			// The same answer for an unknown sandbox: nothing leaks.
			await expectForbidden(
				env.svc.block(env.p, randomUUID(), { reason: "abuse" }),
				"operator_required",
			);
			expect((await sandboxRow(t.pool, s.sandboxId))?.blocked).toBe(false);
		});

		it("an operator blocks a sandbox of any team by id or slug; event with reason, note, by", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const op = operator();
			const sb = await env.svc.block(op, s.slug, {
				reason: "abuse",
				note: "crypto mining",
			});
			expect(sb).toMatchObject({
				id: s.sandboxId,
				teamId: env.p.teamId,
				blocked: true,
				blockReason: "abuse",
			});
			const row = await sandboxRow(t.pool, s.sandboxId);
			expect(row).toMatchObject({
				blocked: true,
				block_reason: "abuse",
				blocked_by: op.userId,
			});
			expect(row?.blocked_at).toBeInstanceOf(Date);
			expect(await events(t.pool, s.sandboxId, "blocked")).toEqual([
				{
					reason: "abuse",
					data: { reason: "abuse", note: "crypto mining", by: op.userId },
				},
			]);
			// The same block again changes nothing; another reason is recorded.
			await env.svc.block(op, s.sandboxId, { reason: "abuse" });
			expect(await events(t.pool, s.sandboxId, "blocked")).toHaveLength(1);
			const again = await env.svc.block(op, s.sandboxId, {
				reason: "operator",
			});
			expect(again.blockReason).toBe("operator");
			expect(await events(t.pool, s.sandboxId, "blocked")).toHaveLength(2);
			// The team sees the block on reads.
			expect(await env.svc.get(env.p, s.sandboxId)).toMatchObject({
				blocked: true,
				blockReason: "operator",
			});
		});

		it("validates the reason and the note; an unknown sandbox is not_found; deleted is invalid_state", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const op = operator();
			for (const input of [
				{ reason: "spam" },
				{},
				{ reason: "abuse", note: "x".repeat(501) },
				{ reason: "abuse", note: 5 },
				{ reason: "abuse", extra: 1 },
			]) {
				await expectCode(
					env.svc.block(op, s.sandboxId, input as never),
					"validation",
				);
			}
			await env.svc.block(op, s.sandboxId, {
				reason: "abuse",
				note: "x".repeat(500),
			});
			await expectCode(
				env.svc.block(op, randomUUID(), { reason: "abuse" }),
				"not_found",
			);
			await expectCode(
				env.svc.block(op, "no-such-sandbox", { reason: "abuse" }),
				"not_found",
			);
			const gone = await seedSandbox(t.pool, env, {
				state: "deleted",
				machineState: null,
			});
			await expectCode(
				env.svc.block(op, gone.sandboxId, { reason: "abuse" }),
				"invalid_state",
			);
		});

		it("unblock lifts the block at once and records it; a repeat is a no-op", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const op = operator();
			await env.svc.block(op, s.sandboxId, { reason: "operator" });
			await expectForbidden(
				env.svc.extend(env.p, s.sandboxId, 60),
				"sandbox_blocked",
			);
			const sb = await env.svc.unblock(op, s.slug, { note: "resolved" });
			expect(sb).toMatchObject({ blocked: false, blockReason: null });
			expect(await sandboxRow(t.pool, s.sandboxId)).toMatchObject({
				blocked: false,
				block_reason: null,
				blocked_at: null,
				blocked_by: null,
			});
			await env.svc.extend(env.p, s.sandboxId, 60);
			expect(await events(t.pool, s.sandboxId, "unblocked")).toEqual([
				{
					reason: "operator",
					data: { reason: "operator", note: "resolved", by: op.userId },
				},
			]);
			await env.svc.unblock(op, s.sandboxId);
			expect(await events(t.pool, s.sandboxId, "unblocked")).toHaveLength(1);
		});

		it("NOTIFY sbx_routes with the slug on block and on unblock", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const op = operator();
			const listener = new pg.Client({ connectionString: t.url });
			await listener.connect();
			const notes: string[] = [];
			listener.on("notification", (n) => {
				if (n.channel === "sbx_routes" && n.payload) notes.push(n.payload);
			});
			await listener.query("LISTEN sbx_routes");
			const waitFor = async (n: number) => {
				for (const end = Date.now() + 10_000; notes.length < n; ) {
					if (Date.now() > end) break;
					await new Promise((r) => setTimeout(r, 20));
				}
			};
			try {
				await env.svc.block(op, s.sandboxId, { reason: "abuse" });
				await waitFor(1);
				expect(notes).toEqual([s.slug]);
				await env.svc.unblock(op, s.sandboxId);
				await waitFor(2);
				expect(notes).toEqual([s.slug, s.slug]);
			} finally {
				await listener.end();
			}
		});
	});

	describe("a blocked sandbox", () => {
		type Action = (
			svc: SandboxServiceImpl,
			p: Principal,
			id: string,
		) => Promise<unknown>;

		interface Case {
			state: string;
			machineState?: string;
			/** Something to set up before the block (a hosted port). */
			before?: (env: ServiceEnv, id: string) => Promise<void>;
			run: Action;
		}

		const port = async (env: ServiceEnv, id: string) => {
			await env.svc.hostPort(env.p, id, 3000, "token");
		};

		const FORBIDDEN: Record<string, Case> = {
			"createCommand (exec, PTY)": {
				state: "ready",
				run: (svc, p, id) =>
					svc.createCommand(p, id, { cmd: "true", mode: "sync" }),
			},
			createCommandWithKey: {
				state: "ready",
				run: (svc, p, id) =>
					svc.createCommandWithKey(
						p,
						id,
						{ cmd: "true", mode: "sync" },
						randomUUID(),
						{ cmd: "true" },
					),
			},
			"resolveAgentTarget for a write (files, input, PTY)": {
				state: "ready",
				run: (svc, p, id) => svc.resolveAgentTarget(p, id, { write: true }),
			},
			"hostPort (publish)": {
				state: "ready",
				run: (svc, p, id) => svc.hostPort(p, id, 3001, "token"),
			},
			"hostPort (change mode)": {
				state: "ready",
				before: port,
				run: (svc, p, id) => svc.hostPort(p, id, 3000, "sso"),
			},
			rotatePortToken: {
				state: "ready",
				before: port,
				run: (svc, p, id) => svc.rotatePortToken(p, id, 3000),
			},
			unhostPort: {
				state: "ready",
				before: port,
				run: (svc, p, id) => svc.unhostPort(p, id, 3000),
			},
			resume: {
				state: "stopped",
				machineState: "stopped",
				run: (svc, p, id) => svc.resume(p, id),
			},
			fork: {
				state: "ready",
				run: (svc, p, id) => svc.fork(p, id, {}),
			},
			recover: {
				state: "ready",
				run: (svc, p, id) => svc.recover(p, id),
			},
			extend: {
				state: "ready",
				run: (svc, p, id) => svc.extend(p, id, 60),
			},
			saveSnapshot: {
				state: "ready",
				run: (svc, p, id) => svc.saveSnapshot(p, id, `snap-${randomUUID()}`),
			},
			"replaceEnv (PUT /env)": {
				state: "ready",
				run: (svc, p, id) => svc.replaceEnv(p, id, { env: { A: "1" } }),
			},
			"patchEnv (PATCH /env)": {
				state: "ready",
				run: (svc, p, id) => svc.patchEnv(p, id, { env: { A: "1" } }),
			},
			"update (PATCH)": {
				state: "ready",
				run: (svc, p, id) => svc.update(p, id, { name: "renamed" }),
			},
			"rename (PATCH slug)": {
				state: "ready",
				run: (svc, p, id) =>
					svc.rename(p, id, `rn-${randomUUID().slice(0, 8)}x`),
			},
		};

		it.each(Object.entries(FORBIDDEN))(
			"%s: sandbox_blocked for the team, an operator in the team may",
			async (_name, c) => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: c.state,
					...(c.machineState === undefined
						? {}
						: { machineState: c.machineState }),
				});
				await c.before?.(env, s.sandboxId);
				await env.svc.block(operator(), s.sandboxId, { reason: "abuse" });
				const before = await sandboxRow(t.pool, s.sandboxId);
				for (const p of [env.p, owner(env.p.teamId)]) {
					await expectForbidden(
						c.run(env.svc, p, s.sandboxId),
						"sandbox_blocked",
					);
				}
				expect(await sandboxRow(t.pool, s.sandboxId)).toEqual(before);
				// An operator with the team selected (Sbx-Team) is not blocked.
				await c.run(env.svc, operator(env.p.teamId), s.sandboxId);
			},
		);

		it("reads, stop and delete stay allowed for the team", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "token");
			const cmd = await env.svc.createCommand(env.p, s.sandboxId, {
				cmd: "true",
				mode: "sync",
			});
			await env.svc.block(operator(), s.sandboxId, { reason: "abuse" });
			const p = env.p;
			expect((await env.svc.get(p, s.sandboxId)).blocked).toBe(true);
			const page = await env.svc.list(p);
			expect(page.data.map((x) => x.id)).toContain(s.sandboxId);
			await env.svc.getEnv(p, s.sandboxId);
			const ports = await env.svc.listHostedPorts(p, s.sandboxId);
			expect(ports.map((x) => x.port)).toEqual([3000]);
			await env.svc.listCommands(p, s.sandboxId, {});
			await env.svc.getCommand(p, s.sandboxId, cmd.id);
			// Reads of files and command output resolve the agent for a read.
			await env.svc.resolveAgentTarget(p, s.sandboxId);
			const stop = await env.svc.stop(p, s.sandboxId);
			expect(stop.kind).toBe("stop");
			const del = await env.svc.delete(p, s.sandboxId);
			expect(del.kind).toBe("delete");
		});

		it("another team's blocked sandbox stays not_found for a non-operator", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.block(operator(), s.sandboxId, { reason: "abuse" });
			const stranger = principal();
			await expectCode(env.svc.extend(stranger, s.sandboxId, 60), "not_found");
			await expectCode(
				env.svc.resolveAgentTarget(stranger, s.sandboxId, { write: true }),
				"not_found",
			);
		});

		it("routes.lookup: blocked with the sandbox's reason over the port's", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
			const label = `${s.slug}-3000`;
			expect(await lookupRoute(t.pool, label)).toMatchObject({
				blocked: false,
				blockReason: null,
			});
			const op = operator();
			await env.svc.blockPort(op, s.sandboxId, 3000, { reason: "operator" });
			expect(await lookupRoute(t.pool, label)).toMatchObject({
				blocked: true,
				blockReason: "operator",
			});
			await env.svc.block(op, s.sandboxId, { reason: "abuse" });
			expect(await lookupRoute(t.pool, label)).toMatchObject({
				blocked: true,
				blockReason: "abuse",
			});
			await env.svc.unblock(op, s.sandboxId);
			await env.svc.unblockPort(op, s.sandboxId, 3000);
			expect(await lookupRoute(t.pool, label)).toMatchObject({
				blocked: false,
				blockReason: null,
			});
		});
	});

	describe("block / unblock a port", () => {
		it("only an operator; an unhosted port is not_found, a reserved one validation", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "token");
			for (const p of [env.p, owner(env.p.teamId)]) {
				await expectForbidden(
					env.svc.blockPort(p, s.sandboxId, 3000, { reason: "abuse" }),
					"operator_required",
				);
				await expectForbidden(
					env.svc.unblockPort(p, s.sandboxId, 3000),
					"operator_required",
				);
			}
			const op = operator();
			await expectCode(
				env.svc.blockPort(op, s.sandboxId, 3001, { reason: "abuse" }),
				"not_found",
			);
			await expectCode(
				env.svc.blockPort(op, s.sandboxId, 22, { reason: "abuse" }),
				"validation",
			);
			await expectCode(
				env.svc.blockPort(op, s.sandboxId, 3000, { reason: "nope" } as never),
				"validation",
			);
		});

		it("PUT, rotate-token and DELETE of the port are port_blocked for the team; other ports are fine", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "token");
			const op = operator();
			const hp = await env.svc.blockPort(op, s.slug, 3000, {
				reason: "abuse",
				note: "phishing",
			});
			expect(hp).toMatchObject({
				port: 3000,
				blocked: true,
				blockReason: "abuse",
			});
			const row = (
				await t.pool.query(
					`SELECT * FROM runtime.hosted_ports
					 WHERE sandbox_id = $1 AND port = 3000 AND deleted_at IS NULL`,
					[s.sandboxId],
				)
			).rows[0];
			expect(row).toMatchObject({ blocked: true, blocked_by: op.userId });
			expect(row.blocked_at).toBeInstanceOf(Date);
			expect(await events(t.pool, s.sandboxId, "port_blocked")).toEqual([
				{
					reason: "abuse",
					data: {
						port: 3000,
						reason: "abuse",
						note: "phishing",
						by: op.userId,
					},
				},
			]);

			const p = env.p;
			await expectForbidden(
				env.svc.hostPort(p, s.sandboxId, 3000, "public"),
				"port_blocked",
			);
			await expectForbidden(
				env.svc.hostPort(p, s.sandboxId, 3000, "token"),
				"port_blocked",
			);
			await expectForbidden(
				env.svc.rotatePortToken(p, s.sandboxId, 3000),
				"port_blocked",
			);
			await expectForbidden(
				env.svc.unhostPort(p, s.sandboxId, 3000),
				"port_blocked",
			);
			// The block survives: still hosted and blocked.
			const [live] = await env.svc.listHostedPorts(p, s.sandboxId);
			expect(live).toMatchObject({ port: 3000, blocked: true });
			// A rename keeps the block on the relabeled row.
			await env.svc.rename(p, s.sandboxId, `rn-${randomUUID().slice(0, 8)}x`);
			expect((await env.svc.listHostedPorts(p, s.sandboxId))[0]).toMatchObject({
				port: 3000,
				blocked: true,
				blockReason: "abuse",
			});
			// Other ports and the rest of the sandbox are not affected.
			await env.svc.hostPort(p, s.sandboxId, 3001, "token");
			await env.svc.extend(p, s.sandboxId, 60);

			// An operator in the team may change it.
			await env.svc.rotatePortToken(operator(p.teamId), s.sandboxId, 3000);

			const un = await env.svc.unblockPort(op, s.sandboxId, 3000);
			expect(un).toMatchObject({ blocked: false, blockReason: null });
			expect(await events(t.pool, s.sandboxId, "port_unblocked")).toHaveLength(
				1,
			);
			await env.svc.rotatePortToken(p, s.sandboxId, 3000);
			await env.svc.unhostPort(p, s.sandboxId, 3000);
		});
	});

	describe("list with allTeams", () => {
		it("operators see every team, filtered by teamId; others are forbidden", async () => {
			const a = await serviceEnv(t.pool);
			const b = await serviceEnv(t.pool);
			const sa = await seedSandbox(t.pool, a, { state: "ready" });
			const sb = await seedSandbox(t.pool, b, { state: "ready" });
			await a.svc.block(operator(), sa.sandboxId, { reason: "abuse" });

			for (const p of [a.p, owner(a.p.teamId)]) {
				await expectForbidden(
					a.svc.list(p, { allTeams: true }),
					"operator_required",
				);
			}
			const forged: Principal = { ...operator(), kind: "oidc" };
			await expectForbidden(
				a.svc.list(forged, { allTeams: true }),
				"operator_required",
			);

			const op = operator();
			const all = await a.svc.list(op, { allTeams: true, limit: 200 });
			const ids = all.data.map((x) => x.id);
			expect(ids).toContain(sa.sandboxId);
			expect(ids).toContain(sb.sandboxId);
			expect(all.data.find((x) => x.id === sa.sandboxId)).toMatchObject({
				teamId: a.p.teamId,
				blocked: true,
				blockReason: "abuse",
			});

			const onlyB = await a.svc.list(op, {
				allTeams: true,
				teamId: b.p.teamId,
			});
			expect(onlyB.data.map((x) => x.id)).toEqual([sb.sandboxId]);

			// Without allTeams an operator lists its own team only.
			const own = await a.svc.list(op);
			expect(own.data).toEqual([]);

			await expectCode(a.svc.list(op, { teamId: b.p.teamId }), "validation");
			await expectCode(
				a.svc.list(op, { allTeams: true, teamId: "team_x" }),
				"validation",
			);
		});

		it("pages across teams with the cursor", async () => {
			const a = await serviceEnv(t.pool);
			const b = await serviceEnv(t.pool);
			const seeded = [
				await seedSandbox(t.pool, a, { state: "ready" }),
				await seedSandbox(t.pool, b, { state: "ready" }),
				await seedSandbox(t.pool, a, { state: "ready" }),
			].map((s) => s.sandboxId);
			const op = operator();
			const seen: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await a.svc.list(op, { allTeams: true, limit: 2 }, cursor);
				seen.push(...page.data.map((x) => x.id));
				cursor = page.nextCursor ?? undefined;
			} while (cursor !== undefined);
			for (const id of seeded) expect(seen).toContain(id);
			expect(new Set(seen).size).toBe(seen.length);
		});
	});
});
