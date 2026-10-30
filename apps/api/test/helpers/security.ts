// Helpers of the security matrices: a fixture of one team built through the
// API (route-table.ts `Fixture`), people of a team, an agent that records
// which machines it was called for, and a dump of a team's stored state.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { encodeUuid, SCOPES, type Scope } from "@sbx/auth";
import { insertOperation, insertSavedSnapshot } from "@sbx/core/testing";
import type pg from "pg";
import {
	type AgentApi,
	type ApiDeps,
	createApiServer,
} from "../../src/index.ts";
import { issueApiKey } from "../../src/testing/index.ts";
import {
	createHarness,
	type Harness,
	type HarnessResponse,
} from "./harness.ts";
import { type Fixture, fresh, type RouteRequest } from "./route-table.ts";
import { ed25519PublicKey } from "./ssh.ts";
import type { ApiWorld } from "./world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
export type Any = any;

/** Sends a route-table request with extra headers. */
export function send(
	h: Harness,
	method: string,
	req: RouteRequest,
	headers: Record<string, string> = {},
): Promise<HarnessResponse> {
	return h.request(method, req.path, {
		headers: { ...req.headers, ...headers },
		...(req.json === undefined ? {} : { json: req.json }),
		...(req.body === undefined ? {} : { body: req.body }),
	});
}

/** The body of a successful answer; throws with the answer otherwise. */
export function ok(r: HarnessResponse, what = "request"): Any {
	if (r.status >= 300) {
		throw new Error(`${what}: ${r.status} ${r.text.slice(0, 500)}`);
	}
	return r.body;
}

/** The `error` object of an error answer (undefined otherwise). */
export function errorOf(r: HarnessResponse): Any {
	return (r.body as Any)?.error;
}

/** A listener app on a real HTTP server (WebSocket upgrades work). */
export async function listen(app: Harness["app"]): Promise<{
	/** `ws://127.0.0.1:<port>` */
	base: string;
	close(): Promise<void>;
}> {
	const { server } = createApiServer(app);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

/** All scopes but one. */
export function scopesWithout(scope: Scope): Scope[] {
	return SCOPES.filter((s) => s !== scope);
}

export interface Person {
	userId: string;
	/** Proxied harness (browser session) of the person. */
	h: Harness;
	/** Session headers (email, user, Origin) for every request. */
	headers: Record<string, string>;
}

/**
 * A person stored in identity.users with this role in `teamId` (its default
 * team), signed in through the browser (proxied listener).
 */
export async function personOf(
	w: ApiWorld,
	teamId: string,
	role: "owner" | "member",
	deps: Partial<ApiDeps> = {},
): Promise<Person> {
	const sub = `sub-${randomUUID()}`;
	const email = `${sub}@example.com`;
	const r = await w.pool.query<{ id: string }>(
		`INSERT INTO identity.users (email, idp_subject, default_team_id)
		 VALUES ($1, $2, $3) RETURNING id`,
		[email, sub, teamId],
	);
	const userId = r.rows[0]?.id as string;
	await w.pool.query(
		"INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, $3)",
		[userId, teamId, role],
	);
	const h = createHarness({ listener: "proxied", deps: w.deps(deps) });
	return {
		userId,
		h,
		headers: {
			"x-auth-request-email": email,
			"x-auth-request-user": sub,
			origin: h.deps.settings.appOrigin,
		},
	};
}

/** A team with a row in identity.teams. */
export async function newTeam(pool: pg.Pool): Promise<string> {
	const id = randomUUID();
	await pool.query("INSERT INTO identity.teams (id, name) VALUES ($1, $2)", [
		id,
		`team-${id}`,
	]);
	return id;
}

export interface TeamFixture extends Fixture {
	sandboxId: string;
	machineId: string;
	slug: string;
}

/**
 * A fixture of `teamId` built through the API with a key of every scope
 * (`h`) and an owner of the team (`owner`, for the SSH key).
 */
export async function buildFixture(
	w: ApiWorld,
	teamId: string,
	h: Harness,
	owner: Person,
): Promise<TeamFixture> {
	const s = await w.seed({ state: "ready", teamId });
	if (s.machineId === null) throw new Error("seeded sandbox has no machine");
	const sandbox = encodeUuid("sandbox", s.sandboxId);
	const base = `/v1/sandboxes/${sandbox}`;
	const octet = { "content-type": "application/octet-stream" };
	for (const name of ["f.txt", "keep.txt"]) {
		ok(
			await h.request("PUT", `${base}/files/content?path=~/${name}`, {
				headers: octet,
				body: `${name} of ${teamId}`,
			}),
			"write a file",
		);
	}
	const command = ok(
		await h.request("POST", `${base}/commands`, {
			json: { command: "cat", mode: "detached", stdin: true },
		}),
		"start a command",
	).id as string;
	const pty = ok(
		await h.request("POST", `${base}/ptys`, { json: { command: "cat" } }),
		"start a pty",
	).id as string;
	const upload = ok(
		await h.request("POST", `${base}/files/uploads`, {
			json: { path: "~/up.bin" },
		}),
		"create an upload",
	).uploadId as string;
	const uploadOffset = ok(
		await h.request("PUT", `${base}/files/uploads/${upload}?offset=0`, {
			headers: octet,
			body: "abc",
		}),
		"upload a chunk",
	).offset as number;
	const operation = encodeUuid(
		"operation",
		await insertOperation(w.pool, {
			sandboxId: s.sandboxId,
			kind: "stop",
			state: "succeeded",
		}),
	);
	const snapshot = fresh("snap");
	await insertSavedSnapshot(w.pool, w.env.topo, { teamId, name: snapshot });
	const port = 3000;
	ok(
		await h.request("PUT", `${base}/ports/${port}`, {
			json: { access: "token" },
		}),
		"publish a port",
	);
	const environmentName = fresh("env");
	const environment = ok(
		await h.request("POST", "/v1/environments", {
			json: { name: environmentName, env: { E: "1" } },
		}),
		"create an environment",
	).id as string;
	const sshKey = ok(
		await owner.h.request("POST", "/v1/ssh-keys", {
			headers: owner.headers,
			json: { name: fresh("ssh"), publicKey: ed25519PublicKey() },
		}),
		"add an SSH key",
	).id as string;
	const apiKey = encodeUuid(
		"apiKey",
		(await issueApiKey(w.identity, { teamId })).key.id,
	);
	return {
		teamId,
		sandbox,
		sandboxId: s.sandboxId,
		machineId: s.machineId,
		slug: s.slug,
		command,
		pty,
		upload,
		uploadOffset,
		operation,
		snapshot,
		port,
		environment,
		environmentName,
		sshKey,
		apiKey,
	};
}

export interface AgentCall {
	method: string;
	machineId: string;
}

/**
 * The agent with every call recorded by machine (the first argument of
 * every AgentApi method). Methods run on the target, so private fields of
 * the FakeAgent stay reachable.
 */
export function recordingAgent(inner: AgentApi): {
	agent: AgentApi;
	calls: AgentCall[];
} {
	const calls: AgentCall[] = [];
	const agent = new Proxy(inner, {
		get(t, k) {
			const v = Reflect.get(t, k);
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => {
				calls.push({ method: String(k), machineId: String(args[0]) });
				return v.apply(t, args);
			};
		},
	});
	return { agent, calls };
}

/**
 * Every stored row of a team that a request could change: sandboxes,
 * machines, operations, commands, ports, secrets, events, snapshots,
 * environments, keys, and the SSH keys of `userIds`. Key usage times are
 * left out (they are written in the background after the fixture's own
 * requests).
 */
export async function teamState(
	pool: pg.Pool,
	teamId: string,
	userIds: string[],
): Promise<Record<string, unknown>> {
	const sandboxes = "SELECT id FROM runtime.sandboxes WHERE team_id = $1";
	const rows = async (sql: string, params: unknown[]) =>
		(await pool.query<{ j: unknown }>(sql, params)).rows[0]?.j ?? null;
	const of = (table: string, where: string) =>
		rows(
			`SELECT json_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS j FROM ${table} t WHERE ${where}`,
			[teamId],
		);
	return {
		sandboxes: await of("runtime.sandboxes", "team_id = $1"),
		machines: await of(
			"runtime.machines",
			"id IN (SELECT machine_id FROM runtime.sandboxes WHERE team_id = $1)",
		),
		operations: await of("runtime.operations", `sandbox_id IN (${sandboxes})`),
		commands: await of("runtime.commands", `sandbox_id IN (${sandboxes})`),
		ports: await of("runtime.hosted_ports", `sandbox_id IN (${sandboxes})`),
		secrets: await of(
			"runtime.sandbox_secrets",
			`sandbox_id IN (${sandboxes})`,
		),
		events: await of("runtime.sandbox_events", `sandbox_id IN (${sandboxes})`),
		snapshots: await of("runtime.snapshots", "team_id = $1"),
		environments: await of("identity.environments", "team_id = $1"),
		apiKeys: await rows(
			`SELECT json_agg(to_jsonb(t) - 'last_used_at' ORDER BY t.id) AS j
			 FROM identity.api_keys t WHERE team_id = $1`,
			[teamId],
		),
		sshKeys: await rows(
			`SELECT json_agg(to_jsonb(t) ORDER BY t.id) AS j
			 FROM identity.ssh_keys t WHERE user_id = ANY($1::uuid[])`,
			[userIds],
		),
	};
}
