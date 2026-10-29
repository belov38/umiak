import { createHash, randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_CMD_MAX_BYTES, RESERVED_PORTS } from "../src/index.ts";
import {
	expectCode,
	sandboxRow,
	seedSandbox,
	serviceEnv,
} from "./helpers/service.ts";
import type { Queryable } from "./helpers/topology.ts";

async function insertSession(
	q: Queryable,
	machineId: string,
	opts: { bootId?: string; capabilities?: string[] } = {},
): Promise<void> {
	await q.query(
		`INSERT INTO tunnel.tunnel_sessions
		   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
		    agent_version, proto_version, capabilities, state, connected_at)
		 VALUES ($1, 'gw-1', 1, 'c1', 'ai-1', $2, 'vmgen', '1.0.0', '1', $3, 'connected', now())`,
		[machineId, opts.bootId ?? "boot-1", opts.capabilities ?? []],
	);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe.skipIf(skipPg())(
	"SandboxService commands, agent target, activity, ports",
	() => {
		let t: TestDatabase;

		beforeAll(async () => {
			t = await createTestDatabase({ max: 20 });
		});
		afterAll(async () => {
			await t?.drop();
		});

		async function cmdRow(id: string) {
			const r = await t.pool.query(
				"SELECT * FROM runtime.commands WHERE id = $1",
				[id],
			);
			return r.rows[0];
		}

		async function portRow(sandboxId: string, port: number) {
			const r = await t.pool.query(
				`SELECT * FROM runtime.hosted_ports WHERE sandbox_id = $1 AND port = $2
			 ORDER BY created_at DESC LIMIT 1`,
				[sandboxId, port],
			);
			return r.rows[0];
		}

		describe("resolveAgentTarget", () => {
			it("returns the machine and the session capabilities of a ready sandbox", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				expect(await env.svc.resolveAgentTarget(env.p, s.slug)).toEqual({
					machineId: s.machineId,
					capabilities: [],
				});
				await insertSession(t.pool, s.machineId ?? "", {
					capabilities: ["pty", "files"],
				});
				expect(await env.svc.resolveAgentTarget(env.p, s.sandboxId)).toEqual({
					machineId: s.machineId,
					capabilities: ["pty", "files"],
				});
			});

			it("is sandbox_not_ready outside ready and not_found for another team", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				const e = await expectCode(
					env.svc.resolveAgentTarget(env.p, s.sandboxId),
					"sandbox_not_ready",
				);
				expect(e.details.state).toBe("stopped");
				const f = await seedSandbox(t.pool, env, {
					state: "ready",
					teamId: randomUUID(),
				});
				await expectCode(
					env.svc.resolveAgentTarget(env.p, f.sandboxId),
					"not_found",
				);
			});
		});

		describe("commands", () => {
			it("createCommand stores a starting ULID row with env names only and the current boot", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				await insertSession(t.pool, s.machineId ?? "", { bootId: "boot-7" });

				const c = await env.svc.createCommand(env.p, s.sandboxId, {
					cmd: "echo hi",
					cwd: "/work",
					env: { API_TOKEN: "env-value-secret", MODE: "x" },
					mode: "detached",
					timeoutSeconds: 60,
					requestId: "req-1",
				});

				expect(c.id).toMatch(ULID_RE);
				expect(c).toMatchObject({
					sandboxId: s.sandboxId,
					machineId: s.machineId,
					cmd: "echo hi",
					cwd: "/work",
					envKeys: ["API_TOKEN", "MODE"],
					mode: "detached",
					timeoutSeconds: 60,
					status: "starting",
					bootId: "boot-7",
					requestId: "req-1",
				});
				const row = await cmdRow(c.id);
				expect(JSON.stringify(row)).not.toContain("env-value-secret");
			});

			it("keeps only the first 64 KiB of cmd without splitting a UTF-8 character", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const cmd = "€".repeat(30_000); // 3 bytes each
				const c = await env.svc.createCommand(env.p, s.sandboxId, {
					cmd,
					mode: "sync",
				});
				expect(COMMAND_CMD_MAX_BYTES).toBe(65_536);
				expect(Buffer.byteLength(c.cmd, "utf8")).toBe(65_535);
				expect(c.cmd).toBe("€".repeat(21_845));
			});

			it("createCommand validates and needs a ready sandbox", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				await expectCode(
					env.svc.createCommand(env.p, s.sandboxId, {
						cmd: "x",
						mode: "bogus" as never,
					}),
					"validation",
				);
				await expectCode(
					env.svc.createCommand(env.p, s.sandboxId, { cmd: "", mode: "sync" }),
					"validation",
				);
				await expectCode(
					env.svc.createCommand(env.p, s.sandboxId, {
						cmd: "a\0b",
						mode: "sync",
					}),
					"validation",
				);
				const stopped = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				await expectCode(
					env.svc.createCommand(env.p, stopped.sandboxId, {
						cmd: "x",
						mode: "sync",
					}),
					"sandbox_not_ready",
				);
			});

			it("completeCommand sets a terminal status once; a terminal status is never overwritten", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const c = await env.svc.createCommand(env.p, s.sandboxId, {
					cmd: "true",
					mode: "sync",
				});
				await env.svc.completeCommand(c.id, {
					status: "exited",
					exitCode: 0,
					stdoutBytes: 10,
					stderrBytes: 2,
				});
				let row = await cmdRow(c.id);
				expect(row).toMatchObject({
					status: "exited",
					exit_code: 0,
					stdout_bytes: "10",
					stderr_bytes: "2",
				});
				expect(row.ended_at).not.toBeNull();

				await env.svc.completeCommand(c.id, { status: "lost" });
				row = await cmdRow(c.id);
				expect(row.status).toBe("exited");
				await expectCode(
					env.svc.completeCommand(c.id, { status: "running" as never }),
					"validation",
				);
			});
		});

		it("touchApiActivity writes at most once per 30 s", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.touchApiActivity(s.sandboxId);
			const first = (await sandboxRow(t.pool, s.sandboxId))?.last_api_call_at;
			expect(first).toBeInstanceOf(Date);
			await env.svc.touchApiActivity(s.sandboxId);
			expect((await sandboxRow(t.pool, s.sandboxId))?.last_api_call_at).toEqual(
				first,
			);
			await t.pool.query(
				"UPDATE runtime.sandboxes SET last_api_call_at = now() - interval '31 seconds' WHERE id = $1",
				[s.sandboxId],
			);
			await env.svc.touchApiActivity(s.sandboxId);
			const third = (await sandboxRow(t.pool, s.sandboxId))
				?.last_api_call_at as Date;
			expect(Date.now() - third.getTime()).toBeLessThan(5_000);
			// Garbage ids are ignored.
			await env.svc.touchApiActivity("not-a-uuid");
		});

		describe("ports", () => {
			it("hostPort in token mode returns the token once and stores only its sha256", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });

				const res = await env.svc.hostPort(env.p, s.sandboxId, 5173, "token");

				expect(res.token).toMatch(/^sbxp_[A-Za-z0-9_-]{43}$/);
				expect(res.hostedPort).toMatchObject({
					sandboxId: s.sandboxId,
					port: 5173,
					label: `${s.slug}-5173`,
					mode: "token",
					authEpoch: 0,
					deletedAt: null,
				});
				const row = await portRow(s.sandboxId, 5173);
				const hash = createHash("sha256")
					.update(res.token ?? "")
					.digest();
				expect(Buffer.compare(row.token_hash, hash)).toBe(0);
				expect(JSON.stringify(row)).not.toContain(res.token ?? "-");

				// The same mode again issues no token.
				const again = await env.svc.hostPort(env.p, s.sandboxId, 5173, "token");
				expect(again.token).toBeUndefined();
				expect(again.hostedPort.id).toBe(res.hostedPort.id);
				expect(again.hostedPort.authEpoch).toBe(0);
			});

			it("changing the mode bumps authEpoch; public stores no hash; back to token issues a token", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, {
					state: "stopped",
					machineState: "stopped",
				});
				await env.svc.hostPort(env.p, s.sandboxId, 3000, "token");
				const pub = await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
				expect(pub.token).toBeUndefined();
				expect(pub.hostedPort.mode).toBe("public");
				expect(pub.hostedPort.authEpoch).toBe(1);
				expect(pub.hostedPort.tokenHash).toBeNull();
				const back = await env.svc.hostPort(env.p, s.sandboxId, 3000, "token");
				expect(back.token).toMatch(/^sbxp_/);
				expect(back.hostedPort.authEpoch).toBe(2);
			});

			it("rejects port 22, reserved ports, out-of-range ports, bad modes and deleting sandboxes", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				expect(RESERVED_PORTS).toContain(22);
				for (const port of [...RESERVED_PORTS, 0, 65_536, 1.5]) {
					await expectCode(
						env.svc.hostPort(env.p, s.sandboxId, port, "public"),
						"validation",
					);
				}
				await expectCode(
					env.svc.hostPort(env.p, s.sandboxId, 80, "open" as never),
					"validation",
				);
				const d = await seedSandbox(t.pool, env, { state: "deleting" });
				await expectCode(
					env.svc.hostPort(env.p, d.sandboxId, 80, "public"),
					"invalid_state",
				);
			});

			it("rotatePortToken issues a new token and bumps authEpoch", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const first = await env.svc.hostPort(env.p, s.sandboxId, 8080, "token");
				const rot = await env.svc.rotatePortToken(env.p, s.sandboxId, 8080);
				expect(rot.token).toMatch(/^sbxp_/);
				expect(rot.token).not.toBe(first.token);
				const row = await portRow(s.sandboxId, 8080);
				expect(row.auth_epoch).toBe(1);
				expect(
					Buffer.compare(
						row.token_hash,
						createHash("sha256").update(rot.token).digest(),
					),
				).toBe(0);

				await env.svc.hostPort(env.p, s.sandboxId, 8081, "sso");
				await expectCode(
					env.svc.rotatePortToken(env.p, s.sandboxId, 8081),
					"validation",
				);
				await expectCode(
					env.svc.rotatePortToken(env.p, s.sandboxId, 9999),
					"not_found",
				);
			});

			it("unhostPort revokes the port; the label can be hosted again", async () => {
				const env = await serviceEnv(t.pool);
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const first = await env.svc.hostPort(
					env.p,
					s.sandboxId,
					4000,
					"public",
				);
				await env.svc.unhostPort(env.p, s.sandboxId, 4000);
				const r = await t.pool.query(
					"SELECT deleted_at, auth_epoch FROM runtime.hosted_ports WHERE id = $1",
					[first.hostedPort.id],
				);
				expect(r.rows[0].deleted_at).not.toBeNull();
				expect(r.rows[0].auth_epoch).toBe(1);
				// Idempotent.
				await env.svc.unhostPort(env.p, s.sandboxId, 4000);
				const second = await env.svc.hostPort(
					env.p,
					s.sandboxId,
					4000,
					"public",
				);
				expect(second.hostedPort.id).not.toBe(first.hostedPort.id);
				// A cookie bound to an earlier epoch of this label must not
				// become valid again (S4 §8.2): the new row's epoch is above
				// every earlier epoch of the label.
				const epochs = async () =>
					(
						await t.pool.query<{ id: string; auth_epoch: number }>(
							"SELECT id, auth_epoch FROM runtime.hosted_ports WHERE label = $1",
							[`${s.slug}-4000`],
						)
					).rows;
				const before = (await epochs()).filter(
					(e) => e.id !== second.hostedPort.id,
				);
				expect(before.length).toBeGreaterThan(0);
				expect(second.hostedPort.authEpoch).toBeGreaterThan(
					Math.max(...before.map((e) => e.auth_epoch)),
				);
				// Again after a token host, rotation and revoke.
				await env.svc.unhostPort(env.p, s.sandboxId, 4000);
				await env.svc.hostPort(env.p, s.sandboxId, 4000, "token");
				await env.svc.rotatePortToken(env.p, s.sandboxId, 4000);
				await env.svc.unhostPort(env.p, s.sandboxId, 4000);
				const third = await env.svc.hostPort(env.p, s.sandboxId, 4000, "token");
				const earlier = (await epochs()).filter(
					(e) => e.id !== third.hostedPort.id,
				);
				expect(third.hostedPort.authEpoch).toBeGreaterThan(
					Math.max(...earlier.map((e) => e.auth_epoch)),
				);
			});
		});
	},
);
