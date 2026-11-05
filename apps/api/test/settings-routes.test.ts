import {
	apiKeyHash,
	OWNER_OPERATOR_GROUP,
	RuntimeIdentityStore,
} from "@umiak/auth";
import { PgConfigReader } from "@umiak/config";
import { checkQuota } from "@umiak/core";
import { withTx } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProxiedApp, createPublicApp } from "../src/app.ts";
import { createTeam } from "../src/settings/service.ts";
import { makeTestDeps, TEST_API_KEY } from "../src/testing/index.ts";
import { assertConforms } from "./helpers/conformance.ts";
import { recordValidated } from "./helpers/conformance-coverage.ts";
import { OPENAPI_DOC } from "./helpers/harness.ts";

let db: TestDatabase;
let deps: ReturnType<typeof makeTestDeps>;
beforeAll(async () => {
	db = await createTestDatabase();
	deps = makeTestDeps({
		pool: db.pool,
		identity: new RuntimeIdentityStore({
			pool: db.pool,
			operatorGroups: [OWNER_OPERATOR_GROUP],
		}),
		config: new PgConfigReader({ pool: db.pool }),
	});
});
afterAll(async () => {
	await db?.drop();
});
async function request(
	path: string,
	method = "GET",
	body?: unknown,
	extra: Record<string, string> = {},
) {
	const response = await createProxiedApp(deps).request(
		`/v1/settings/${path}`,
		{
			method,
			headers: {
				host: new URL(deps.settings.apiUrl).host,
				origin: deps.settings.appOrigin,
				"content-type": "application/json",
				...extra,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
		{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
	);
	const result = assertConforms(
		OPENAPI_DOC,
		method,
		`/v1/settings/${path}`,
		response.status,
		response.headers.get("content-type") ?? "",
		await response.clone().json(),
	);
	recordValidated(result.operationId, response.status);
	return response;
}
it("exposes owner session and full configuration without hashes", async () => {
	const response = await request("session");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		isOperator: true,
		teams: expect.any(Array),
	});
	const templates = await request("templates");
	expect(templates.status).toBe(200);
	expect(JSON.stringify(await templates.json())).not.toContain("secretHash");
});
it("validates immutable slugs, size references, default size and personal team deletion", async () => {
	expect(
		(await request("templates/linux", "PATCH", { slug: "renamed" })).status,
	).toBe(400);
	expect(
		(await request("templates/linux", "PATCH", { defaultSize: "missing" }))
			.status,
	).toBe(400);
	expect((await request("sizes/2gb", "DELETE")).status).toBe(409);
	const session = (await (await request("session")).json()) as {
		teams: { id: string; personal: boolean }[];
	};
	expect(
		(
			await request(
				`teams/${session.teams.find((t) => t.personal)?.id}`,
				"DELETE",
			)
		).status,
	).toBe(409);
});
it("creates and edits owner workspaces, preserving settings across bootstrap", async () => {
	const r = await request("teams", "POST", { name: "Workspace" });
	expect(r.status).toBe(200);
	const team = (await r.json()) as { id: string };
	expect(
		(
			await request(`teams/${team.id}`, "PATCH", {
				name: "Renamed",
				quota: { maxRamMb: 3456 },
			})
		).status,
	).toBe(200);
	expect(
		(await request("account", "PATCH", { defaultTeamId: team.id })).status,
	).toBe(200);
	expect((await request(`teams/${team.id}`, "DELETE")).status).toBe(200);
});
it("rejects cross-origin mutations and all-scope team keys", async () => {
	expect(
		(
			await request(
				"sizes",
				"POST",
				{ slug: "bad", vcpu: 1, memoryMb: 1024 },
				{ origin: "https://evil.example" },
			)
		).status,
	).toBe(403);
	const team = (await db.pool.query("SELECT id FROM runtime.teams LIMIT 1"))
		.rows[0].id;
	await db.pool.query(
		"INSERT INTO runtime.api_keys(name,team_id,secret_hash,prefix,last4,scopes,expires_at,created_via) VALUES('full',$1,$2,'prefix','last',$3,now()+interval '1 day','api')",
		[
			team,
			apiKeyHash(TEST_API_KEY),
			JSON.stringify(["sandbox:read", "sandbox:write"]),
		],
	);
	const r = await createPublicApp(deps).request(
		"/v1/settings/templates",
		{
			headers: {
				host: new URL(deps.settings.apiUrl).host,
				authorization: `Bearer ${TEST_API_KEY}`,
			},
		},
		{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
	);
	expect(r.status).toBe(403);
});

it("validates successful answers for every settings operation", async () => {
	const expected = [
		"session",
		"updateAccount",
		"listTeams",
		"createTeam",
		"getTeam",
		"updateTeam",
		"deleteTeam",
		"listtemplates",
		"createtemplates",
		"updatetemplates",
		"deletetemplates",
		"listsizes",
		"createsizes",
		"updatesizes",
		"deletesizes",
		"defaults",
		"updateDefaults",
	];
	const documented = Object.values(OPENAPI_DOC.paths)
		.flatMap((item) =>
			Object.values(item).map(
				(op) => (op as { operationId?: string }).operationId,
			),
		)
		.filter((id): id is string => !!id?.startsWith("settings."));
	expect(documented.sort()).toEqual(
		expected.map((id) => `settings.${id}`).sort(),
	);
	async function success(path: string, method = "GET", body?: unknown) {
		const response = await request(path, method, body);
		expect(response.status, await response.clone().text()).toBe(200);
		return response.json();
	}
	const session = await success("session");
	await success("account", "PATCH", { defaultTeamId: session.defaultTeamId });
	await success("teams");
	const team = await success("teams", "POST", {
		name: "Conformance workspace",
	});
	await success(`teams/${team.id}`);
	await success(`teams/${team.id}`, "PATCH", { name: "Updated" });
	await success(`teams/${team.id}`, "DELETE");
	await success("templates");
	await success("templates", "POST", {
		slug: "settings-test",
		os: "linux",
		enabled: false,
		defaultSize: "2gb",
		allowedSizes: ["2gb"],
	});
	await success("templates/settings-test", "PATCH", { name: "Updated" });
	expect(
		(await success("templates")).find(
			(t: { slug: string }) => t.slug === "settings-test",
		).enabled,
	).toBe(false);
	await success("templates/settings-test", "DELETE");
	await success("sizes");
	await success("sizes", "POST", {
		slug: "settings-size",
		vcpu: 1,
		memoryMb: 1024,
	});
	await success("sizes/settings-size", "PATCH", { vcpu: 2 });
	await success("sizes/settings-size", "DELETE");
	const defaults = await success("platform-defaults");
	await success("platform-defaults", "PUT", defaults);
	for (const [path, entry] of Object.entries(OPENAPI_DOC.paths)) {
		if (!path.startsWith("/v1/settings/")) continue;
		for (const method of Object.keys(entry)) {
			const url = path
				.replace("{teamId}", session.defaultTeamId)
				.replace("{slug}", "linux");
			const response = await createPublicApp(deps).request(
				url,
				{
					method: method.toUpperCase(),
					headers: {
						host: new URL(deps.settings.apiUrl).host,
						authorization: `Bearer ${TEST_API_KEY}`,
					},
				},
				{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
			);
			expect(response.status, `${method} ${url}`).toBe(403);
		}
	}
});

it("creates a workspace with a one-connection pool", async () => {
	const pool = new pg.Pool({ connectionString: db.url, max: 1 });
	try {
		const user = (await db.pool.query("SELECT id FROM runtime.users LIMIT 1"))
			.rows[0].id;
		const team = await createTeam(pool, user, "Single connection");
		expect(team.name).toBe("Single connection");
		await request(`teams/${team.id}`, "DELETE");
	} finally {
		await pool.end();
	}
});
it("round-trips imported nullable defaults", async () => {
	await db.pool.query(
		"UPDATE runtime.platform_defaults SET rate_limits_requests_per_second=NULL,rate_limits_burst=NULL,rate_limits_starts_per_minute=NULL,max_owned_teams_per_user=NULL,public_ports_enabled=NULL,public_desktop_enabled=NULL",
	);
	const response = await request("platform-defaults");
	expect(response.status).toBe(200);
	const value = await response.json();
	expect(value.rateLimits.requestsPerSecond).toBeNull();
	expect((await request("platform-defaults", "PUT", value)).status).toBe(200);
});
it("rejects stale quota admission after concurrent workspace deletion", async () => {
	const reader = new PgConfigReader({ pool: db.pool });
	const id = (
		await db.pool.query(
			"INSERT INTO runtime.teams(name) VALUES('Delete race') RETURNING id",
		)
	).rows[0].id;
	const quota = await reader.teamQuota(id);
	const deleting = await db.pool.connect();
	await deleting.query("BEGIN");
	await deleting.query(
		"SELECT pg_advisory_xact_lock(hashtextextended('team:' || $1::text,0))",
		[id],
	);
	const pending = withTx(db.pool, (tx) =>
		checkQuota(tx, id, quota, {
			addSandboxes: 1,
			teamExists: reader.teamExists.bind(reader),
		}),
	);
	const rejected = expect(pending).rejects.toThrow("workspace");
	try {
		await deleting.query("DELETE FROM runtime.teams WHERE id=$1", [id]);
		await deleting.query("COMMIT");
		await rejected;
	} finally {
		deleting.release();
	}
});
