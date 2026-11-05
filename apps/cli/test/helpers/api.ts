// The api of the CLI tests: apps/api's public app in process on a real HTTP
// server, Postgres from @umiak/db/testing (PgIdentityStore: team keys, JIT users
// from Keycloak JWTs), core's SandboxService over a test topology, and the
// test OIDC server (device flow, refresh, revocation) as Keycloak. Built from
// the exported pieces of @umiak/api/testing, like the SDK's test helper.

import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type ApiDeps, createApiServer, createPublicApp } from "@umiak/api";
import {
	FakeAgent,
	issueApiKey,
	makeTestDeps,
	testSettings,
} from "@umiak/api/testing";
import {
	encodeUuid,
	loadSshCa,
	OWNER_OPERATOR_GROUP,
	ownerSessionHeaders,
	PgEnvironmentStore,
	type SshCa,
} from "@umiak/auth";
import { validateSecretSets } from "@umiak/core";
import { type ServiceEnv, serviceEnv } from "@umiak/core/testing";
import { withTx } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";

export interface CliWorld {
	/** URL of the api (http://127.0.0.1:<port>). */
	url: string;
	db: TestDatabase;
	env: ServiceEnv;
	deps: ApiDeps;
	/** The agent fake behind command and file routes. */
	agent: FakeAgent;
	/** Public id of the team of `secret`. */
	teamId: string;
	/** Secret of a team key with every scope. */
	secret: string;
	/** The SSH login CA of the api (certificates of `umiak ssh`). */
	sshCa: SshCa;
	/** Gateway host keys ("<type> <base64>") served by /v1/meta. */
	hostKeys: string[];
	/** SSH endpoint of /v1/meta: host ssh.umiak.test, port 2222. */
	ssh: { host: string; port: number };
	/** "METHOD /path?query" of every request the api received. */
	requests: string[];
	/** A new key of the team. */
	key(): Promise<string>;
	/** Creates a sandbox in the team through the api; returns {id, slug}. */
	createSandbox(): Promise<{ id: string; slug: string }>;
	/** The worker's end of create/resume/recover: ready, machine running, operations succeeded. */
	markReady(slug: string): Promise<void>;
	/** The worker's end of stop: stopped, machine stopped, operations succeeded. */
	markStopped(slug: string): Promise<void>;
	/** The worker's end of a failed create: error, operations failed. */
	markError(slug: string): Promise<void>;
	/** The worker's end of save_snapshot: the snapshot `name` is ready. */
	markSnapshotReady(name: string): Promise<void>;
	/** A ready sandbox created through the api. */
	readySandbox(): Promise<{ id: string; slug: string }>;
	close(): Promise<void>;
}

/**
 * Polls `fn` until it returns a value (not undefined); fails after `ms` (a
 * hang guard with room for a heavily loaded machine).
 */
export async function until<T>(
	fn: () => Promise<T | undefined>,
	ms = 30_000,
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

export interface WorldOptions {
	/** Extra api settings (env names), e.g. UMIAK_OIDC_ISSUER behind a TLS front. */
	settings?: Record<string, string>;
	/** A started OIDC server to use instead of a new one. */
	/** Logger of the api (captureLogs().log), for debugging. */
	log?: ApiDeps["log"];
}

export async function startWorld(o: WorldOptions = {}): Promise<CliWorld> {
	const db = await createTestDatabase({ max: 20 });
	const pool = db.pool;
	// A node big enough for every sandbox of a suite (the default is 4 × 2 GB).
	const env = await serviceEnv(pool, {
		topology: { node: { ramCapMb: 1_048_576 } },
	});
	const team = env.p.teamId;
	await pool.query("INSERT INTO identity.teams (id, name) VALUES ($1, $2)", [
		team,
		`team-${team.slice(0, 8)}`,
	]);
	const agent = new FakeAgent();
	const sshCa = loadSshCa(
		generateKeyPairSync("ed25519")
			.privateKey.export({ format: "pem", type: "pkcs8" })
			.toString(),
	);
	// Any ed25519 public key stands for the gateway's host key.
	const hostKeys = [sshCa.publicKey];
	const ssh = { host: "ssh.umiak.test", port: 2222 };
	const deps = makeTestDeps({
		settings: testSettings({
			UMIAK_API_RATE_BURST: "100000",
			UMIAK_API_RATE_STARTS_PER_MIN: "100000",
			UMIAK_SSH_HOST: ssh.host,
			UMIAK_SSH_PORT: String(ssh.port),
			...o.settings,
		}),
		sshCa,
		hostKeys,
		pool,
		svc: env.svc,
		config: env.config,
		jobs: env.jobs,
		agent,
		environments: new PgEnvironmentStore(pool, env.keys, {
			validateSets: validateSecretSets,
		}),
		...(o.log === undefined ? {} : { log: o.log }),
	});
	const { secret } = await issueApiKey(deps.identity, { teamId: team });
	const ownerToken = `umiak_owner_${crypto.randomUUID()}`;
	const owner = await deps.identity.resolveSession(ownerSessionHeaders());
	await pool.query(
		"INSERT INTO identity.memberships(user_id,team_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",
		[owner.user.id, team],
	);
	await pool.query("UPDATE identity.users SET default_team_id=$2 WHERE id=$1", [
		owner.user.id,
		team,
	]);
	deps.settings.operatorGroups.push(OWNER_OPERATOR_GROUP);
	const app = createPublicApp(deps);
	// Test ingress: pairing auto-approves; production pairing is covered by quickstart.
	let revoked = false;
	const { server } = createApiServer({
		fetch(request, env) {
			const path = new URL(request.url).pathname;
			if (path === "/owner/pair") {
				revoked = false;
				return Response.json({
					id: "pair",
					secret: "private",
					interval: 0,
					expiresIn: 600,
				});
			}
			if (path === "/owner/pair/poll")
				return Response.json({ token: ownerToken });
			if (path === "/owner/logout") {
				revoked = true;
				return Response.json({ ok: true });
			}
			if (request.headers.get("authorization") === `Bearer ${ownerToken}`) {
				if (revoked)
					return Response.json(
						{
							error: {
								code: "unauthorized",
								message: "Owner credential revoked",
								retryable: false,
								details: {},
								requestId: "req_test",
							},
						},
						{ status: 401 },
					);
				request.headers.delete("authorization");
			}
			return app.fetch(request, env);
		},
	});
	const requests: string[] = [];
	server.on("request", (req) => {
		requests.push(`${req.method} ${req.url}`);
	});
	server.on("upgrade", (req) => {
		requests.push(`UPGRADE ${req.url}`);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	deps.settings.ownerHosts.push(new URL(url).host);
	const finish = async (
		slug: string,
		sandbox: string,
		machine: string,
		op: "succeeded" | "failed",
	) => {
		const r = await pool.query<{ id: string }>(
			"SELECT id FROM runtime.sandboxes WHERE slug = $1",
			[slug],
		);
		const id = r.rows[0]?.id;
		if (id === undefined) throw new Error(`no sandbox ${slug}`);
		// One transaction, as the worker commits it: a waiter woken by the
		// state change sees the finished operation too.
		await withTx(pool, async (tx) => {
			await tx.client.query(
				`UPDATE runtime.machines SET state = $2, power_observed = $3
				 WHERE id = (SELECT machine_id FROM runtime.sandboxes WHERE id = $1)`,
				[id, machine, machine === "running" ? "running" : "stopped"],
			);
			await tx.client.query(
				`UPDATE runtime.operations
				 SET state = $2, started_at = COALESCE(started_at, now()), finished_at = now()
				 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
				[id, op],
			);
			await tx.client.query(
				`UPDATE runtime.sandboxes
				 SET state = $2, state_changed_at = now(), version = version + 1,
				     ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE ready_at END,
				     stopped_at = CASE WHEN $2 = 'stopped' THEN now() ELSE stopped_at END
				 WHERE id = $1`,
				[id, sandbox],
			);
		});
	};
	const createSandbox = async () => {
		const res = await fetch(`${url}/v1/sandboxes`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				"idempotency-key": crypto.randomUUID(),
			},
			body: "{}",
		});
		if (res.status !== 202 && res.status !== 201 && res.status !== 200) {
			throw new Error(`create: ${res.status} ${await res.text()}`);
		}
		const b = (await res.json()) as {
			sandbox?: { id: string; slug: string };
			id?: string;
			slug?: string;
		};
		const sb = b.sandbox ?? (b as { id: string; slug: string });
		return { id: sb.id, slug: sb.slug };
	};
	const markReady = (slug: string) =>
		finish(slug, "ready", "running", "succeeded");
	return {
		url,
		db,
		env,
		deps,
		agent,
		teamId: encodeUuid("team", team),
		secret,
		sshCa,
		hostKeys,
		ssh,
		requests,
		key: async () =>
			(await issueApiKey(deps.identity, { teamId: team })).secret,
		createSandbox,
		markReady,
		markStopped: (slug) => finish(slug, "stopped", "stopped", "succeeded"),
		markError: (slug) => finish(slug, "error", "running", "failed"),
		async markSnapshotReady(name) {
			const r = await pool.query<{ id: string; source_sandbox_id: string }>(
				`UPDATE runtime.snapshots
				 SET state = 'ready', name = pending_name, pending_name = NULL,
				     ready_at = now(), consistency = 'quiesced', version = version + 1
				 WHERE kind = 'saved' AND pending_name = $1 AND state = 'creating'
				 RETURNING id, source_sandbox_id`,
				[name],
			);
			const snap = r.rows[0];
			if (snap === undefined) throw new Error(`no creating snapshot ${name}`);
			await pool.query(
				`UPDATE runtime.operations
				 SET state = 'succeeded', started_at = COALESCE(started_at, now()), finished_at = now()
				 WHERE sandbox_id = $1 AND kind = 'save_snapshot' AND state IN ('pending', 'running')`,
				[snap.source_sandbox_id],
			);
		},
		async readySandbox() {
			const sb = await createSandbox();
			await markReady(sb.slug);
			return sb;
		},
		async close() {
			await new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			});
			deps.streams.close();
			await agent.close();
			await db.drop();
		},
	};
}
