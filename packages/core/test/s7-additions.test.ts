import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	idempotencyPrincipal,
	lookupRoute,
	PgNotifier,
	type Principal,
	sshTarget,
	teamUsage,
	uuidv7,
} from "../src/index.ts";
import {
	expectCode,
	insertSavedSnapshot,
	principal,
	readSecrets,
	seedSandbox,
	serviceEnv,
} from "./helpers/service.ts";
import { insertOperation } from "./helpers/topology.ts";

// S7 §20.2 additions to the service layer.

describe.skipIf(skipPg())("S7 additions to SandboxService", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function commandRows(sandboxId: string) {
		const r = await t.pool.query(
			"SELECT * FROM runtime.commands WHERE sandbox_id = $1",
			[sandboxId],
		);
		return r.rows;
	}

	async function livePort(sandboxId: string, port: number) {
		const r = await t.pool.query(
			`SELECT * FROM runtime.hosted_ports
			 WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL`,
			[sandboxId, port],
		);
		return r.rows[0];
	}

	describe("createCommandWithKey", () => {
		const body = { command: "npm test", mode: "detached" };

		it("a repeat with the same key and body returns the same command with replayed: true", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const spec = {
				cmd: "npm test",
				mode: "detached" as const,
				user: "root",
				argv: null,
				tags: { step: "test" },
			};

			const first = await env.svc.createCommandWithKey(
				env.p,
				s.sandboxId,
				spec,
				"key-1",
				body,
			);
			expect(first.replayed).toBe(false);
			expect(first.command).toMatchObject({
				sandboxId: s.sandboxId,
				cmd: "npm test",
				user: "root",
				argv: null,
				tags: { step: "test" },
				pid: null,
				status: "starting",
				// A team key: no user, the key is recorded (S7 §8.1, §9.6).
				createdBy: null,
				createdByKey: env.p.apiKeyId,
			});
			expect((await commandRows(s.sandboxId))[0]).toMatchObject({
				created_by: null,
				created_by_key: env.p.apiKeyId,
			});

			// The sandbox is no longer ready: a repeat still returns the command.
			await t.pool.query(
				"UPDATE runtime.sandboxes SET state = 'stopped' WHERE id = $1",
				[s.sandboxId],
			);
			const again = await env.svc.createCommandWithKey(
				env.p,
				s.slug,
				spec,
				"key-1",
				body,
			);
			expect(again.replayed).toBe(true);
			expect(again.command.id).toBe(first.command.id);
			expect(await commandRows(s.sandboxId)).toHaveLength(1);

			const key = await t.pool.query(
				`SELECT scope, response, sandbox_id FROM runtime.idempotency_keys
				 WHERE principal_id = $1 AND key = 'key-1'`,
				[idempotencyPrincipal(env.p)],
			);
			expect(key.rows).toEqual([
				{
					scope: "commands.create",
					response: { commandId: first.command.id },
					sandbox_id: s.sandboxId,
				},
			]);
		});

		it("another body or another sandbox with the same key is idempotency_key_reused", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const other = await seedSandbox(t.pool, env, { state: "ready" });
			const spec = { cmd: "npm test", mode: "detached" as const };
			await env.svc.createCommandWithKey(env.p, s.sandboxId, spec, "k", body);

			await expectCode(
				env.svc.createCommandWithKey(env.p, s.sandboxId, spec, "k", {
					...body,
					command: "npm run build",
				}),
				"idempotency_key_reused",
			);
			await expectCode(
				env.svc.createCommandWithKey(env.p, other.sandboxId, spec, "k", body),
				"idempotency_key_reused",
			);
			expect(await commandRows(other.sandboxId)).toHaveLength(0);
		});

		it("5 parallel calls with one key create one command row", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const spec = { cmd: "sleep 1", mode: "stream" as const };
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					env.svc.createCommandWithKey(env.p, s.sandboxId, spec, "par", body),
				),
			);
			const ids = new Set(results.map((r) => r.command.id));
			expect(ids.size).toBe(1);
			expect(results.filter((r) => !r.replayed)).toHaveLength(1);
			expect(await commandRows(s.sandboxId)).toHaveLength(1);
		});

		it("a first call on a sandbox that is not ready is sandbox_not_ready and keeps no key", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, {
				state: "stopped",
				machineState: "stopped",
			});
			await expectCode(
				env.svc.createCommandWithKey(
					env.p,
					s.sandboxId,
					{ cmd: "x", mode: "sync" },
					"nr",
					body,
				),
				"sandbox_not_ready",
			);
			const key = await t.pool.query(
				"SELECT 1 FROM runtime.idempotency_keys WHERE principal_id = $1",
				[idempotencyPrincipal(env.p)],
			);
			expect(key.rowCount).toBe(0);
		});

		it("validates user, argv and tags", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			for (const bad of [
				{ cmd: "x", mode: "sync", user: "" },
				{ cmd: "x", mode: "sync", argv: [] },
				{ cmd: "x", mode: "sync", argv: ["a", 1] },
				{ cmd: "x", mode: "sync", tags: { a: 1 } },
				{ cmd: "", mode: "sync" },
			]) {
				await expectCode(
					// biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
					env.svc.createCommand(env.p, s.sandboxId, bad as any),
					"validation",
				);
			}
			// argv without a shell string: cmd may be empty.
			const c = await env.svc.createCommand(env.p, s.sandboxId, {
				cmd: "",
				argv: ["ls", "-la"],
				mode: "sync",
			});
			expect(c).toMatchObject({ argv: ["ls", "-la"], user: "user", tags: {} });
		});
	});

	describe("command creator", () => {
		it("a user principal is created_by with a null created_by_key", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const { apiKeyId: _key, ...base } = principal();
			const user: Principal = {
				...base,
				kind: "session",
				userId: randomUUID(),
				teamId: env.p.teamId,
				role: "member",
			};
			const c = await env.svc.createCommand(user, s.sandboxId, {
				cmd: "x",
				mode: "sync",
			});
			expect(c).toMatchObject({ createdBy: user.userId, createdByKey: null });
			const k = await env.svc.createCommandWithKey(
				user,
				s.sandboxId,
				{ cmd: "y", mode: "sync" },
				"user-key",
				{ command: "y" },
			);
			expect(k.command).toMatchObject({
				createdBy: user.userId,
				createdByKey: null,
			});
		});
	});

	describe("markCommandRunning", () => {
		it("moves starting to running with the pid and started_at; terminal stays", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const c = await env.svc.createCommand(env.p, s.sandboxId, {
				cmd: "x",
				mode: "detached",
			});
			await env.svc.markCommandRunning(c.id, 4242);
			const running = await env.svc.getCommand(env.p, s.sandboxId, c.id);
			expect(running.status).toBe("running");
			expect(running.pid).toBe(4242);
			expect(running.startedAt).toBeInstanceOf(Date);

			await env.svc.completeCommand(c.id, { status: "exited", exitCode: 0 });
			await env.svc.markCommandRunning(c.id, 1);
			const done = await env.svc.getCommand(env.p, s.sandboxId, c.id);
			expect(done).toMatchObject({ status: "exited", pid: 4242 });

			await expectCode(
				env.svc.markCommandRunning("01JBXUNKNOWN0000000000000", null),
				"not_found",
			);
		});
	});

	describe("failCommandStart", () => {
		it("moves only starting to failed_to_start; running or ended stays", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const spec = { cmd: "x", mode: "detached" as const };
			const a = await env.svc.createCommand(env.p, s.sandboxId, spec);
			await env.svc.failCommandStart(a.id);
			const failed = await env.svc.getCommand(env.p, s.sandboxId, a.id);
			expect(failed.status).toBe("failed_to_start");
			expect(failed.reason).toBe("start_failed");
			expect(failed.endedAt).toBeInstanceOf(Date);

			const b = await env.svc.createCommand(env.p, s.sandboxId, spec);
			await env.svc.markCommandRunning(b.id, 7);
			await env.svc.failCommandStart(b.id);
			expect(await env.svc.getCommand(env.p, s.sandboxId, b.id)).toMatchObject({
				status: "running",
				reason: null,
			});
		});
	});

	describe("waitForState with a signal", () => {
		it("an abort rejects with the reason and stops the wait (unsubscribed)", async () => {
			let subscribed = 0;
			const notifier = {
				subscribe: () => {
					subscribed++;
					return () => {
						subscribed--;
					};
				},
				close: async () => {},
			};
			const env = await serviceEnv(t.pool, { notifier });
			const s = await seedSandbox(t.pool, env, { state: "starting" });
			const ac = new AbortController();
			const waiting = env.svc.waitForState(
				s.sandboxId,
				["ready"],
				20_000,
				ac.signal,
			);
			expect(subscribed).toBe(1);
			const reason = new Error("client gone");
			ac.abort(reason);
			await expect(waiting).rejects.toBe(reason);
			expect(subscribed).toBe(0);
			const pre = new AbortController();
			pre.abort(reason);
			await expect(
				env.svc.waitForState(s.sandboxId, ["ready"], 20_000, pre.signal),
			).rejects.toBe(reason);
			expect(subscribed).toBe(0);
		});
	});

	describe("listCommands and getCommand", () => {
		it("lists newest first with filters and a cursor, on a stopped sandbox too", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const c = await env.svc.createCommand(env.p, s.sandboxId, {
					cmd: `echo ${i}`,
					mode: i % 2 === 0 ? "detached" : "sync",
				});
				ids.push(c.id);
			}
			await env.svc.markCommandRunning(ids[4] ?? "", 1);
			await t.pool.query(
				"UPDATE runtime.sandboxes SET state = 'stopped' WHERE id = $1",
				[s.sandboxId],
			);

			const p1 = await env.svc.listCommands(env.p, s.slug, { limit: 2 });
			expect(p1.data.map((c) => c.id)).toEqual([ids[4], ids[3]]);
			expect(p1.nextCursor).not.toBeNull();
			const p2 = await env.svc.listCommands(
				env.p,
				s.slug,
				{ limit: 2 },
				p1.nextCursor ?? undefined,
			);
			expect(p2.data.map((c) => c.id)).toEqual([ids[2], ids[1]]);
			const p3 = await env.svc.listCommands(
				env.p,
				s.slug,
				{ limit: 2 },
				p2.nextCursor ?? undefined,
			);
			expect(p3.data.map((c) => c.id)).toEqual([ids[0]]);
			expect(p3.nextCursor).toBeNull();

			const running = await env.svc.listCommands(env.p, s.sandboxId, {
				status: ["running"],
			});
			expect(running.data.map((c) => c.id)).toEqual([ids[4]]);
			const sync = await env.svc.listCommands(env.p, s.sandboxId, {
				mode: "sync",
			});
			expect(sync.data.map((c) => c.id)).toEqual([ids[3], ids[1]]);

			await expectCode(
				env.svc.listCommands(env.p, s.sandboxId, {}, "garbage"),
				"validation",
			);
			await expectCode(
				// biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
				env.svc.listCommands(env.p, s.sandboxId, { status: ["nope" as any] }),
				"validation",
			);
		});

		it("another sandbox's command, another team or a deleted sandbox is not_found", async () => {
			const env = await serviceEnv(t.pool);
			const a = await seedSandbox(t.pool, env, { state: "ready" });
			const b = await seedSandbox(t.pool, env, { state: "ready" });
			const c = await env.svc.createCommand(env.p, a.sandboxId, {
				cmd: "x",
				mode: "sync",
			});
			expect((await env.svc.getCommand(env.p, a.slug, c.id)).id).toBe(c.id);
			await expectCode(
				env.svc.getCommand(env.p, b.sandboxId, c.id),
				"not_found",
			);
			await expectCode(
				env.svc.getCommand(principal(), a.sandboxId, c.id),
				"not_found",
			);
			await expectCode(
				env.svc.listCommands(principal(), a.sandboxId, {}),
				"not_found",
			);
			await t.pool.query(
				"UPDATE runtime.sandboxes SET state = 'deleted' WHERE id = $1",
				[a.sandboxId],
			);
			await expectCode(
				env.svc.listCommands(env.p, a.sandboxId, {}),
				"not_found",
			);
			await expectCode(
				env.svc.getCommand(env.p, a.sandboxId, c.id),
				"not_found",
			);
		});
	});

	describe("hostPort options and listHostedPorts", () => {
		it("hosts with options; the same settings again are created: false without a token", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });

			const first = await env.svc.hostPort(env.p, s.sandboxId, 3000, {
				access: "token",
				hostRewrite: "localhost",
			});
			expect(first.created).toBe(true);
			expect(first.token).toMatch(/^sbxp_/);
			expect(first.hostedPort).toMatchObject({
				mode: "token",
				hostRewrite: "localhost",
				appProtocol: "http1",
				blocked: false,
				blockReason: null,
			});

			const again = await env.svc.hostPort(env.p, s.sandboxId, 3000, {
				access: "token",
				hostRewrite: "localhost",
			});
			expect(again.created).toBe(false);
			expect(again.token).toBeUndefined();
			expect(again.hostedPort.authEpoch).toBe(first.hostedPort.authEpoch);

			// Only the proxy options change: no new epoch, no new token.
			const h2c = await env.svc.hostPort(env.p, s.sandboxId, 3000, {
				access: "token",
				hostRewrite: "localhost",
				appProtocol: "h2c",
			});
			expect(h2c.created).toBe(false);
			expect(h2c.token).toBeUndefined();
			expect(h2c.hostedPort).toMatchObject({
				appProtocol: "h2c",
				authEpoch: first.hostedPort.authEpoch,
				id: first.hostedPort.id,
			});
			expect((await livePort(s.sandboxId, 3000)).token_hash).toEqual(
				first.hostedPort.tokenHash,
			);

			// The old string form: defaults for the options, a mode change bumps the epoch.
			const pub = await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
			expect(pub.created).toBe(false);
			expect(pub.hostedPort).toMatchObject({
				mode: "public",
				hostRewrite: "preserve",
				appProtocol: "http1",
				authEpoch: first.hostedPort.authEpoch + 1,
				tokenHash: null,
			});

			await expectCode(
				env.svc.hostPort(env.p, s.sandboxId, 3001, {
					access: "token",
					// biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
					hostRewrite: "rewrite" as any,
				}),
				"validation",
			);
		});

		it("listHostedPorts returns the live ports by port number", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 8080, "public");
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "sso");
			await env.svc.hostPort(env.p, s.sandboxId, 5000, "public");
			await env.svc.unhostPort(env.p, s.sandboxId, 5000);
			const ports = await env.svc.listHostedPorts(env.p, s.slug);
			expect(ports.map((p) => [p.port, p.mode])).toEqual([
				[3000, "sso"],
				[8080, "public"],
			]);
			await expectCode(
				env.svc.listHostedPorts(principal(), s.sandboxId),
				"not_found",
			);
		});
	});

	describe("rename", () => {
		it("relabels live ports with auth_epoch + 1 and notifies the old and the new slug", async () => {
			const env = await serviceEnv(t.pool);
			const oldSlug = `old-${randomUUID().slice(0, 8)}x`;
			const newSlug = `new-${randomUUID().slice(0, 8)}x`;
			const s = await seedSandbox(t.pool, env, {
				state: "ready",
				slug: oldSlug,
			});
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
			await env.svc.hostPort(env.p, s.sandboxId, 3000, "sso");
			// epoch 2 under the old label: cookies of `<old>-3000` carry it.
			const port = await env.svc.hostPort(env.p, s.sandboxId, 3000, "public");
			expect(port.hostedPort.label).toBe(`${oldSlug}-3000`);
			expect(port.hostedPort.authEpoch).toBe(2);

			const listener = new pg.Client({ connectionString: t.url });
			await listener.connect();
			const notes: string[] = [];
			listener.on("notification", (n) => {
				if (n.channel === "sbx_routes" && n.payload) notes.push(n.payload);
			});
			await listener.query("LISTEN sbx_routes");
			try {
				const renamed = await env.svc.rename(env.p, s.sandboxId, newSlug);
				expect(renamed.slug).toBe(newSlug);
				const live = await livePort(s.sandboxId, 3000);
				expect(live.label).toBe(`${newSlug}-3000`);
				expect(live.auth_epoch).toBe(port.hostedPort.authEpoch + 1);
				expect(live.id).toBe(port.hostedPort.id);
				// Delivery after commit: wait for both notifications.
				for (const end = Date.now() + 10_000; notes.length < 2; ) {
					if (Date.now() > end) break;
					await new Promise((r) => setTimeout(r, 20));
				}
				expect(notes).toContain(oldSlug);
				expect(notes).toContain(newSlug);
			} finally {
				await listener.end();
			}

			// A sandbox renamed into the old slug never reuses an epoch of the old label.
			// Its own epoch + 1 would be exactly 2 here.
			const other = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, other.sandboxId, 3000, "public");
			await env.svc.hostPort(env.p, other.sandboxId, 3000, "sso");
			await env.svc.rename(env.p, other.sandboxId, oldSlug);
			const reused = await livePort(other.sandboxId, 3000);
			expect(reused.label).toBe(`${oldSlug}-3000`);
			expect(reused.auth_epoch).toBeGreaterThan(port.hostedPort.authEpoch);
		});

		it("slug_taken, validation, invalid_state in deleting, not_found for another team", async () => {
			const env = await serviceEnv(t.pool);
			const a = await seedSandbox(t.pool, env, { state: "ready" });
			const b = await seedSandbox(t.pool, env, { state: "stopped" });
			await expectCode(
				env.svc.rename(env.p, a.sandboxId, b.slug),
				"slug_taken",
			);
			await expectCode(
				env.svc.rename(env.p, a.sandboxId, "Bad--slug"),
				"validation",
			);
			await expectCode(
				env.svc.rename(env.p, a.sandboxId, "box-12"),
				"validation",
			);
			await expectCode(
				env.svc.rename(
					principal(),
					a.sandboxId,
					`x-${randomUUID().slice(0, 6)}z`,
				),
				"not_found",
			);
			// The same slug is a no-op.
			expect((await env.svc.rename(env.p, a.sandboxId, a.slug)).slug).toBe(
				a.slug,
			);
			await t.pool.query(
				"UPDATE runtime.sandboxes SET state = 'deleting' WHERE id = $1",
				[a.sandboxId],
			);
			await expectCode(
				env.svc.rename(env.p, a.sandboxId, `y-${randomUUID().slice(0, 6)}z`),
				"invalid_state",
			);
		});
	});

	describe("saved snapshots", () => {
		it("getSavedSnapshot returns ready by name, else creating by pending name, else snapshot_not_found", async () => {
			const env = await serviceEnv(t.pool);
			const src = await seedSandbox(t.pool, env, { state: "ready" });
			const { snapshot } = await env.svc.saveSnapshot(
				env.p,
				src.sandboxId,
				"web-stack",
			);
			const got = await env.svc.getSavedSnapshot(env.p, "web-stack");
			expect(got).toMatchObject({
				id: snapshot.id,
				state: "creating",
				pendingName: "web-stack",
			});

			const readyId = await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "web-stack",
			});
			expect((await env.svc.getSavedSnapshot(env.p, "web-stack")).id).toBe(
				readyId,
			);
			await expectCode(
				env.svc.getSavedSnapshot(env.p, "nothing-here"),
				"snapshot_not_found",
			);
			await expectCode(
				env.svc.getSavedSnapshot(principal(), "web-stack"),
				"snapshot_not_found",
			);
			await expectCode(
				env.svc.getSavedSnapshot(env.p, "Bad Name"),
				"snapshot_not_found",
			);
		});

		it("listSavedSnapshots shows failed of the last day, not older ones", async () => {
			const env = await serviceEnv(t.pool);
			const recent = await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "recent",
				state: "failed",
			});
			const old = await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "old",
				state: "failed",
			});
			await t.pool.query(
				`UPDATE runtime.snapshots SET created_at = now() - interval '1 hour' WHERE id = $1`,
				[recent],
			);
			await t.pool.query(
				`UPDATE runtime.snapshots SET created_at = now() - interval '2 days' WHERE id = $1`,
				[old],
			);
			const ready = await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "good",
			});
			const ids = (await env.svc.listSavedSnapshots(env.p)).map((s) => s.id);
			expect(ids).toContain(recent);
			expect(ids).toContain(ready);
			expect(ids).not.toContain(old);
		});
	});

	describe("env", () => {
		const sets = {
			env: { NODE_ENV: "test", KEEP: "1" },
			secrets: { A: "secret-a", B: "secret-b" },
			secretFiles: [{ name: "key.json", contentBase64: "e30=" }],
		};

		it("getEnv returns the decrypted sets", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready", sets });
			expect(await env.svc.getEnv(env.p, s.slug)).toEqual(sets);
			await expectCode(env.svc.getEnv(principal(), s.sandboxId), "not_found");
		});

		it("patchEnv with {secrets: {A: null}} deletes the key and keeps the rest", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "stopped", sets });
			const res = await env.svc.patchEnv(env.p, s.sandboxId, {
				secrets: { A: null },
				env: { NEW: "x" },
			});
			const want = {
				env: { NODE_ENV: "test", KEEP: "1", NEW: "x" },
				secrets: { B: "secret-b" },
				secretFiles: sets.secretFiles,
			};
			expect(res.sets).toEqual(want);
			expect(res.sandbox.id).toBe(s.sandboxId);
			expect(await readSecrets(t.pool, env.keys, s.sandboxId)).toEqual(want);

			await expectCode(
				env.svc.patchEnv(env.p, s.sandboxId, { env: { SBX_TOKEN: "x" } }),
				"validation",
			);
		});

		it("replaceEnv replaces each given set whole and keeps the others", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready", sets });
			const res = await env.svc.replaceEnv(env.p, s.sandboxId, {
				env: { ONLY: "1" },
				secretFiles: [],
			});
			const want = {
				env: { ONLY: "1" },
				secrets: sets.secrets,
				secretFiles: [],
			};
			expect(res.sets).toEqual(want);
			expect(await readSecrets(t.pool, env.keys, s.sandboxId)).toEqual(want);

			await expectCode(
				// biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
				env.svc.replaceEnv(env.p, s.sandboxId, { other: {} } as any),
				"validation",
			);
			await t.pool.query(
				"UPDATE runtime.sandboxes SET state = 'deleting' WHERE id = $1",
				[s.sandboxId],
			);
			await expectCode(
				env.svc.replaceEnv(env.p, s.sandboxId, { env: {} }),
				"invalid_state",
			);
			await expectCode(
				env.svc.patchEnv(env.p, s.sandboxId, { env: {} }),
				"invalid_state",
			);
		});
	});

	describe("waitForOperation", () => {
		it("returns on the UPDATE to succeeded well before the timeout", async () => {
			const notifier = new PgNotifier({ connectionString: t.url });
			try {
				// No fallback poll within the test: only the notification (or the
				// 20 s timeout) can end the wait.
				const env = await serviceEnv(t.pool, {
					notifier,
					waitPollMs: 3_600_000,
				});
				const s = await seedSandbox(t.pool, env, { state: "ready" });
				const opId = await insertOperation(t.pool, {
					id: uuidv7(),
					sandboxId: s.sandboxId,
					kind: "save_snapshot",
					state: "running",
				});
				const started = Date.now();
				const waiting = env.svc.waitForOperation(opId, 20_000);
				setTimeout(
					() =>
						void t.pool.query(
							"UPDATE runtime.operations SET state = 'succeeded' WHERE id = $1",
							[opId],
						),
					200,
				);
				const op = await waiting;
				expect(op.state).toBe("succeeded");
				// Well before the timeout: the notification woke it.
				expect(Date.now() - started).toBeLessThan(10_000);

				// Terminal already: at once. Timeout: the current operation.
				expect((await env.svc.waitForOperation(opId, 5000)).state).toBe(
					"succeeded",
				);
				const pending = await insertOperation(t.pool, {
					id: uuidv7(),
					sandboxId: s.sandboxId,
					kind: "stop",
				});
				expect((await env.svc.waitForOperation(pending, 200)).state).toBe(
					"pending",
				);
				await expectCode(env.svc.waitForOperation(uuidv7(), 100), "not_found");
			} finally {
				await notifier.close();
			}
		});
	});

	describe("teamUsage", () => {
		it("counts active sandboxes, their RAM and saved snapshots like checkQuota", async () => {
			const env = await serviceEnv(t.pool);
			await seedSandbox(t.pool, env, { state: "ready" });
			await seedSandbox(t.pool, env, { state: "creating", memoryMb: 4096 });
			await seedSandbox(t.pool, env, {
				state: "stopped",
				machineState: "stopped",
			});
			await seedSandbox(t.pool, env, { state: "error", machineState: null });
			await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "a",
			});
			await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "b",
				state: "creating",
			});
			await insertSavedSnapshot(t.pool, env.topo, {
				teamId: env.p.teamId,
				name: "c",
				state: "failed",
			});
			expect(await teamUsage(t.pool, env.p.teamId)).toEqual({
				activeSandboxes: 2,
				ramMb: 2048 + 4096,
				savedSnapshots: 2,
			});
			expect(await teamUsage(t.pool, randomUUID())).toEqual({
				activeSandboxes: 0,
				ramMb: 0,
				savedSnapshots: 0,
			});
		});
	});

	describe("routes", () => {
		it("lookup returns team, proxy options and blocks; sshTarget returns team, slug, template", async () => {
			const env = await serviceEnv(t.pool);
			const s = await seedSandbox(t.pool, env, { state: "ready" });
			await env.svc.hostPort(env.p, s.sandboxId, 3000, {
				access: "sso",
				appProtocol: "h2c",
			});
			expect(await lookupRoute(t.pool, `${s.slug}-3000`)).toMatchObject({
				teamId: env.p.teamId,
				hostRewrite: "preserve",
				appProtocol: "h2c",
				blocked: false,
				blockReason: null,
			});

			await t.pool.query(
				`UPDATE runtime.hosted_ports SET blocked = true, block_reason = 'port abuse'
				 WHERE sandbox_id = $1`,
				[s.sandboxId],
			);
			expect(await lookupRoute(t.pool, `${s.slug}-3000`)).toMatchObject({
				blocked: true,
				blockReason: "port abuse",
			});
			await t.pool.query(
				`UPDATE runtime.hosted_ports SET blocked = false, block_reason = NULL
				 WHERE sandbox_id = $1`,
				[s.sandboxId],
			);
			await t.pool.query(
				`UPDATE runtime.sandboxes SET blocked = true, block_reason = 'abuse' WHERE id = $1`,
				[s.sandboxId],
			);
			expect(await lookupRoute(t.pool, `${s.slug}-3000`)).toMatchObject({
				blocked: true,
				blockReason: "abuse",
			});

			expect(await sshTarget(t.pool, s.slug)).toEqual({
				sandboxId: s.sandboxId,
				machineId: s.machineId,
				state: "ready",
				teamId: env.p.teamId,
				slug: s.slug,
				templateSlug: env.template,
			});
		});
	});
});
