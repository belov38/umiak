// The real api for the integration test (S11 14.4): apps/api's public app in
// process on a real HTTP server, Postgres from @umiak/db/testing, core's
// SandboxService over a test topology, a FakeAgent behind the command and
// file routes, and a team key with every scope. Built from the exported
// pieces of @umiak/api/testing like apps/cli/test/helpers/api.ts; the worker is
// not running, so `markReady` and `markStopped` stand in for it.
import type { AddressInfo } from "node:net";
import { createApiServer, createPublicApp } from "@umiak/api";
import {
	FakeAgent,
	issueApiKey,
	makeTestDeps,
	testSettings,
} from "@umiak/api/testing";
import { serviceEnv } from "@umiak/core/testing";
import { withTx } from "@umiak/db";
import { createTestDatabase } from "@umiak/db/testing";

export interface RealApi {
	/** http://127.0.0.1:<port> */
	url: string;
	/** Secret of a team key with every scope. */
	secret: string;
	/** The agent fake behind command and file routes. */
	agent: FakeAgent;
	/** "METHOD /path?query" of every request the api received. */
	requests: string[];
	/** State of a sandbox by slug (null: unknown). */
	stateOf(slug: string): Promise<string | null>;
	/** The worker's end of create/resume: ready, machine running, operations succeeded. */
	markReady(slug: string): Promise<void>;
	/** The worker's end of stop: stopped, machine stopped, operations succeeded. */
	markStopped(slug: string): Promise<void>;
	close(): Promise<void>;
}

/** Polls `fn` until it returns a value (not undefined); a hang guard. */
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

export async function startRealApi(): Promise<RealApi> {
	const db = await createTestDatabase({ max: 20 });
	const pool = db.pool;
	// A node big enough for every sandbox of the suite (the default is 4 x 2 GB).
	const env = await serviceEnv(pool, {
		topology: { node: { ramCapMb: 1_048_576 } },
	});
	const teamId = env.p.teamId;
	await pool.query("INSERT INTO identity.teams (id, name) VALUES ($1, $2)", [
		teamId,
		`team-${teamId.slice(0, 8)}`,
	]);
	const agent = new FakeAgent();
	const deps = makeTestDeps({
		settings: testSettings({
			UMIAK_API_RATE_BURST: "100000",
			UMIAK_API_RATE_STARTS_PER_MIN: "100000",
		}),
		pool,
		svc: env.svc,
		config: env.config,
		jobs: env.jobs,
		agent,
	});
	const { secret } = await issueApiKey(deps.identity, { teamId });
	const { server, wss } = createApiServer(createPublicApp(deps));
	const requests: string[] = [];
	server.on("request", (req) => {
		requests.push(`${req.method} ${req.url}`);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	deps.settings.ownerHosts.push(new URL(url).host);

	const finish = async (
		slug: string,
		sandbox: string,
		machine: string,
	): Promise<void> => {
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
				 SET state = 'succeeded', started_at = COALESCE(started_at, now()), finished_at = now()
				 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
				[id],
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

	return {
		url,
		secret,
		agent,
		requests,
		async stateOf(slug) {
			const r = await pool.query<{ state: string }>(
				"SELECT state FROM runtime.sandboxes WHERE slug = $1",
				[slug],
			);
			return r.rows[0]?.state ?? null;
		},
		markReady: (slug) => finish(slug, "ready", "running"),
		markStopped: (slug) => finish(slug, "stopped", "stopped"),
		async close() {
			for (const ws of wss.clients) ws.terminate();
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
