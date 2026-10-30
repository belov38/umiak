// The api of the CLI tests: apps/api's public app in process on a real HTTP
// server, Postgres from @sbx/db/testing (PgIdentityStore: team keys, JIT users
// from Keycloak JWTs), core's SandboxService over a test topology, and the
// test OIDC server (device flow, refresh, revocation) as Keycloak. Built from
// the exported pieces of @sbx/api/testing, like the SDK's test helper.

import type { AddressInfo } from "node:net";
import { type ApiDeps, createApiServer, createPublicApp } from "@sbx/api";
import {
	FakeAgent,
	issueApiKey,
	makeTestDeps,
	startTestOidcServer,
	type TestOidcServer,
	type TestOidcServerOptions,
	testSettings,
} from "@sbx/api/testing";
import { encodeUuid } from "@sbx/auth";
import { type ServiceEnv, serviceEnv } from "@sbx/core/testing";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";

export interface CliWorld {
	/** URL of the api (http://127.0.0.1:<port>). */
	url: string;
	oidc: TestOidcServer;
	db: TestDatabase;
	env: ServiceEnv;
	deps: ApiDeps;
	/** The agent fake behind command and file routes. */
	agent: FakeAgent;
	/** Public id of the team of `secret`. */
	teamId: string;
	/** Secret of a team key with every scope. */
	secret: string;
	/** A new key of the team. */
	key(): Promise<string>;
	/** Creates a sandbox in the team through the api; returns {id, slug}. */
	createSandbox(): Promise<{ id: string; slug: string }>;
	close(): Promise<void>;
}

export interface WorldOptions {
	oidc?: TestOidcServerOptions;
	/** Extra api settings (env names), e.g. SBX_OIDC_ISSUER behind a TLS front. */
	settings?: Record<string, string>;
	/** A started OIDC server to use instead of a new one. */
	oidcServer?: TestOidcServer;
}

export async function startWorld(o: WorldOptions = {}): Promise<CliWorld> {
	const db = await createTestDatabase({ max: 20 });
	const pool = db.pool;
	const oidc = o.oidcServer ?? (await startTestOidcServer(o.oidc));
	const env = await serviceEnv(pool);
	const team = env.p.teamId;
	await pool.query("INSERT INTO identity.teams (id, name) VALUES ($1, $2)", [
		team,
		`team-${team.slice(0, 8)}`,
	]);
	const agent = new FakeAgent();
	const deps = makeTestDeps({
		settings: testSettings({
			SBX_API_RATE_BURST: "100000",
			SBX_API_RATE_STARTS_PER_MIN: "100000",
			SBX_OIDC_ISSUER: oidc.issuer,
			...o.settings,
		}),
		pool,
		svc: env.svc,
		config: env.config,
		jobs: env.jobs,
		agent,
	});
	const { secret } = await issueApiKey(deps.identity, { teamId: team });
	const { server } = createApiServer(createPublicApp(deps));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		oidc,
		db,
		env,
		deps,
		agent,
		teamId: encodeUuid("team", team),
		secret,
		key: async () =>
			(await issueApiKey(deps.identity, { teamId: team })).secret,
		async createSandbox() {
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
		},
		async close() {
			await new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			});
			deps.streams.close();
			await agent.close();
			if (o.oidcServer === undefined) await oidc.close();
			await db.drop();
		},
	};
}
