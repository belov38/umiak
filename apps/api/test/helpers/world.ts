// Test world of the resource routes: a SandboxService of core over the test
// database (S6 topology of `serviceEnv`), a PgIdentityStore with the
// service's team, team keys, environments, a FakeAgent and harness
// builders. State helpers stand in for the worker (markReady, markState,
// finishOperation).
import { randomUUID } from "node:crypto";
import { PgEnvironmentStore, PgIdentityStore, type Scope } from "@umiak/auth";
import { validateSecretSets } from "@umiak/core";
import {
	type EnvOptions,
	type Seeded,
	type SeedOptions,
	type ServiceEnv,
	seedSandbox,
	serviceEnv,
} from "@umiak/core/testing";
import { withTx } from "@umiak/db";
import type pg from "pg";
import type { ApiDeps } from "../../src/index.ts";
import {
	FakeAgent,
	issueApiKey,
	testIdentityStore,
	testSettings,
} from "../../src/testing/index.ts";
import { createHarness, type Harness, type Listener } from "./harness.ts";

export interface ApiWorld {
	pool: pg.Pool;
	/** Core fixtures: template, topology, config, keys, svc, jobs. */
	env: ServiceEnv;
	/** Team of the world (= env.p.teamId), also a row of identity.teams. */
	teamId: string;
	identity: PgIdentityStore;
	environments: PgEnvironmentStore;
	agent: FakeAgent;
	/** Secret of a team key with every scope. */
	secret: string;
	/** Id (uuid) of that key. */
	keyId: string;
	/** Deps for `createHarness` (rate limits raised). */
	deps(over?: Partial<ApiDeps>): Partial<ApiDeps>;
	/** Harness over `deps()` with the all-scopes key unless `bearer` is given. */
	harness(o?: {
		listener?: Listener;
		bearer?: string;
		deps?: Partial<ApiDeps>;
	}): Harness;
	/**
	 * A browser session in the world's team on the proxied listener (an
	 * in-memory identity store); send `headers` with every request.
	 */
	session(o?: { isOperator?: boolean; deps?: Partial<ApiDeps> }): {
		h: Harness;
		headers: Record<string, string>;
	};
	/**
	 * A browser session of a user stored in identity.users with this role in
	 * the world's team (its default team), through `identity`; for writes
	 * that reference the user (environments `updated_by`).
	 */
	dbSession(o: { role: "owner" | "member"; deps?: Partial<ApiDeps> }): Promise<{
		h: Harness;
		headers: Record<string, string>;
		userId: string;
	}>;
	/** A new key of the team with these scopes. */
	key(scopes: Scope[]): Promise<{ secret: string; id: string }>;
	/** A sandbox row of the world's template and team (core's seedSandbox). */
	seed(opts: SeedOptions): Promise<Seeded>;
	/** The worker's end of create/resume/recover: ready, machine running, ops succeeded. */
	markReady(sandboxId: string): Promise<void>;
	markState(sandboxId: string, state: string): Promise<void>;
	finishOperation(operationId: string, state: string): Promise<void>;
	close(): Promise<void>;
}

export async function apiWorld(
	pool: pg.Pool,
	opts: EnvOptions = {},
): Promise<ApiWorld> {
	const env = await serviceEnv(pool, opts);
	const teamId = env.p.teamId;
	await pool.query("INSERT INTO identity.teams (id, name) VALUES ($1, $2)", [
		teamId,
		`team-${randomUUID()}`,
	]);
	const identity = new PgIdentityStore({ pool, operatorGroups: [] });
	const environments = new PgEnvironmentStore(pool, env.keys, {
		validateSets: validateSecretSets,
	});
	const agent = new FakeAgent();
	const { secret, key } = await issueApiKey(identity, { teamId });
	const settings = testSettings({
		UMIAK_API_RATE_BURST: "100000",
		UMIAK_API_RATE_STARTS_PER_MIN: "100000",
	});

	const deps = (over: Partial<ApiDeps> = {}): Partial<ApiDeps> => ({
		settings,
		pool,
		identity,
		svc: env.svc,
		config: env.config,
		environments,
		agent,
		jobs: env.jobs,
		...over,
	});

	return {
		pool,
		env,
		teamId,
		identity,
		environments,
		agent,
		secret,
		keyId: key.id,
		deps,
		harness: (o = {}) =>
			createHarness({
				...(o.listener === undefined ? {} : { listener: o.listener }),
				deps: deps(o.deps),
				bearer: o.bearer ?? secret,
			}),
		session(o = {}) {
			const sub = `sub-${randomUUID()}`;
			const identity = testIdentityStore({
				sessions: [
					{
						sub,
						teams: [{ teamId, name: "world team", role: "owner" }],
						isOperator: o.isOperator ?? false,
					},
				],
			});
			const h = createHarness({
				listener: "proxied",
				deps: deps({ identity, ...o.deps }),
			});
			return {
				h,
				headers: {
					"x-auth-request-email": `${sub}@example.com`,
					"x-auth-request-user": sub,
					origin: settings.appOrigin,
				},
			};
		},
		async dbSession(o) {
			const sub = `sub-${randomUUID()}`;
			const email = `${sub}@example.com`;
			const r = await pool.query<{ id: string }>(
				`INSERT INTO identity.users (email, idp_subject, default_team_id)
				 VALUES ($1, $2, $3) RETURNING id`,
				[email, sub, teamId],
			);
			const userId = r.rows[0]?.id as string;
			await pool.query(
				"INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, $3)",
				[userId, teamId, o.role],
			);
			return {
				h: createHarness({ listener: "proxied", deps: deps(o.deps) }),
				headers: {
					"x-auth-request-email": email,
					"x-auth-request-user": sub,
					origin: settings.appOrigin,
				},
				userId,
			};
		},
		async key(scopes) {
			const r = await issueApiKey(identity, { teamId, scopes });
			return { secret: r.secret, id: r.key.id };
		},
		seed: (o) => seedSandbox(pool, env, o),
		async markReady(sandboxId) {
			// One transaction, as the worker commits it: a waiter woken by the
			// state change sees the finished operation too.
			await withTx(pool, async (tx) => {
				await tx.client.query(
					`UPDATE runtime.sandboxes
					 SET state = 'ready', ready_at = now(), state_changed_at = now(), version = version + 1
					 WHERE id = $1`,
					[sandboxId],
				);
				await tx.client.query(
					`UPDATE runtime.machines SET state = 'running', power_observed = 'running'
					 WHERE id = (SELECT machine_id FROM runtime.sandboxes WHERE id = $1)`,
					[sandboxId],
				);
				await tx.client.query(
					`UPDATE runtime.operations
					 SET state = 'succeeded', started_at = COALESCE(started_at, now()), finished_at = now()
					 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
					[sandboxId],
				);
			});
		},
		async markState(sandboxId, state) {
			await pool.query(
				`UPDATE runtime.sandboxes SET state = $2, state_changed_at = now(), version = version + 1
				 WHERE id = $1`,
				[sandboxId, state],
			);
		},
		async finishOperation(operationId, state) {
			await pool.query(
				`UPDATE runtime.operations
				 SET state = $2, started_at = COALESCE(started_at, now()),
				     finished_at = CASE WHEN $2 IN ('pending', 'running') THEN NULL ELSE now() END
				 WHERE id = $1`,
				[operationId, state],
			);
		},
		close: () => agent.close(),
	};
}
