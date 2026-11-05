// The api of the facade tests: apps/api in process on a real HTTP server
// (createApiServer: HTTP and the PTY WebSocket), Postgres from
// @umiak/db/testing, core's SandboxService over a test topology, a FakeAgent
// and a team key with every scope. `markReady` stands in for the worker.
// `intercept` puts a one-shot fault in front of the SDK's fetch.

import type { AddressInfo } from "node:net";
import { type ApiDeps, createApiServer, createPublicApp } from "@umiak/api";
import {
	FakeAgent,
	issueApiKey,
	makeTestDeps,
	testSettings,
} from "@umiak/api/testing";
import { type ServiceEnv, serviceEnv } from "@umiak/core/testing";
import { withTx } from "@umiak/db";
import type { TestDatabase } from "@umiak/db/testing";

type Pool = TestDatabase["pool"];

/** Returns a response to replace the real one, or null to pass the request on. */
export type Hook = (
	req: Request,
	next: (req: Request) => Promise<Response>,
) => Promise<Response | null>;

export interface TestApi {
	url: string;
	/** Secret of a team key with every scope. */
	secret: string;
	/** A new key of the team with only these scopes. */
	key(scopes: string[]): Promise<string>;
	env: ServiceEnv;
	agent: FakeAgent;
	deps: ApiDeps;
	/** Requests the SDK sent through `fetch`, in order (method and path). */
	requests: { method: string; path: string; headers: Headers }[];
	/** The fetch to give the SDK: real fetch behind the hooks. */
	fetch: typeof fetch;
	/** Runs `hook` on the following requests until it returns a response once. */
	intercept(hook: Hook): void;
	/** Server-side WebSocket clients (PTY connections). */
	sockets(): { terminate(): void }[];
	/** Core uuid and machine of a sandbox by slug. */
	sandboxRow(slug: string): Promise<{ id: string; machineId: string | null }>;
	/** The worker's end of create/resume: ready, machine running, operations succeeded. */
	markReady(slug: string): Promise<void>;
	close(): Promise<void>;
}

export async function startTestApi(db: TestDatabase): Promise<TestApi> {
	const pool = db.pool;
	const env = await serviceEnv(pool);
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
		agent,
		jobs: env.jobs,
	});
	const { secret } = await issueApiKey(deps.identity, { teamId });
	const { server, wss } = createApiServer(createPublicApp(deps));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	deps.settings.ownerHosts.push(new URL(url).host);

	const requests: TestApi["requests"] = [];
	const hooks: Hook[] = [];
	const real = (req: Request) => globalThis.fetch(req);
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		const u = new URL(req.url);
		requests.push({
			method: req.method,
			path: u.pathname + u.search,
			headers: new Headers(req.headers),
		});
		for (const hook of [...hooks]) {
			const r = await hook(req, real);
			if (r !== null) {
				hooks.splice(hooks.indexOf(hook), 1);
				return r;
			}
		}
		return real(req);
	};

	return {
		url,
		secret,
		key: async (scopes) =>
			(
				await issueApiKey(deps.identity, {
					teamId,
					scopes: scopes as never,
				})
			).secret,
		env,
		agent,
		deps,
		requests,
		fetch: fetchImpl as typeof fetch,
		intercept: (hook) => {
			hooks.push(hook);
		},
		sockets: () => [...wss.clients],
		sandboxRow: (slug) => sandboxRow(pool, slug),
		markReady: (slug) => markSandboxReady(pool, slug),
		async close() {
			for (const ws of wss.clients) ws.terminate();
			await new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			});
			deps.streams.close();
			await agent.close();
		},
	};
}

/** Core uuid and machine of a sandbox by slug. */
export async function sandboxRow(
	pool: Pool,
	slug: string,
): Promise<{ id: string; machineId: string | null }> {
	const r = await pool.query<{ id: string; machine_id: string | null }>(
		"SELECT id, machine_id FROM runtime.sandboxes WHERE slug = $1",
		[slug],
	);
	const row = r.rows[0];
	if (row === undefined) throw new Error(`no sandbox ${slug}`);
	return { id: row.id, machineId: row.machine_id };
}

/** The worker's end of create/resume: ready, machine running, operations succeeded. */
export async function markSandboxReady(
	pool: Pool,
	slug: string,
): Promise<void> {
	const { id } = await sandboxRow(pool, slug);
	// One transaction, as the worker commits it: a waiter woken by the
	// state change sees the finished operation too.
	await withTx(pool, async (tx) => {
		await tx.client.query(
			`UPDATE runtime.sandboxes
			 SET state = 'ready', ready_at = now(), state_changed_at = now(), version = version + 1
			 WHERE id = $1`,
			[id],
		);
		await tx.client.query(
			`UPDATE runtime.machines SET state = 'running', power_observed = 'running'
			 WHERE id = (SELECT machine_id FROM runtime.sandboxes WHERE id = $1)`,
			[id],
		);
		await tx.client.query(
			`UPDATE runtime.operations
			 SET state = 'succeeded', started_at = COALESCE(started_at, now()), finished_at = now()
			 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
			[id],
		);
	});
}
