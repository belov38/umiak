// The fake API of the MCP contract tests: every request and response is
// checked against apps/api/openapi/v1.json (and the S10 desktop fragment).
import { createHash } from "node:crypto";
import { Sbx } from "@sbx/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EMIT_UNIT,
	emitPattern,
	FAKE_TEAM,
	FAKE_TOKENS,
	type FakeApi,
	INJECT_FENCE_END,
	OTHER_TEAM,
	scaleToFit,
	startFakeApi,
} from "./fake-api/index.ts";
import { Contract } from "./fake-api/openapi-check.ts";

let api: FakeApi;

beforeEach(async () => {
	api = await startFakeApi({ heartbeatMs: 30, readyAfterMs: 10 });
});

afterEach(async () => {
	await api.close();
});

// JSON of the replies is asserted field by field.
// biome-ignore lint/suspicious/noExplicitAny: loose JSON in assertions
type Json = any;

interface Reply {
	status: number;
	headers: Headers;
	json: Json;
	bytes: Uint8Array;
}

async function call(
	method: string,
	path: string,
	o: {
		token?: string | null;
		body?: unknown;
		raw?: Uint8Array | string;
		headers?: Record<string, string>;
	} = {},
): Promise<Reply> {
	const headers: Record<string, string> = { ...o.headers };
	const token = o.token === undefined ? FAKE_TOKENS.full : o.token;
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	let body: BodyInit | null = null;
	if (o.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(o.body);
	} else if (o.raw !== undefined) {
		headers["Content-Type"] = "application/octet-stream";
		body = typeof o.raw === "string" ? o.raw : new Uint8Array(o.raw);
	}
	const res = await fetch(`${api.url}${path}`, { method, headers, body });
	const bytes = new Uint8Array(await res.arrayBuffer());
	let json: unknown;
	if (res.headers.get("content-type")?.startsWith("application/json")) {
		json = JSON.parse(new TextDecoder().decode(bytes));
	}
	return { status: res.status, headers: res.headers, json, bytes };
}

function frames(r: Reply): Json[] {
	return new TextDecoder()
		.decode(r.bytes)
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => JSON.parse(l));
}

async function createReady(
	body: Record<string, unknown> = {},
	token?: string,
): Promise<string> {
	const r = await call("POST", "/v1/sandboxes", {
		body,
		...(token ? { token } : {}),
	});
	expect(r.status).toBe(202);
	const id = r.json.sandbox.id as string;
	const w = await call(
		"GET",
		`/v1/sandboxes/${id}?waitFor=ready&waitSeconds=5`,
		{
			...(token ? { token } : {}),
		},
	);
	expect(w.json.state).toBe("ready");
	return id;
}

function commandOf(id: string) {
	const cmd = api.state.commands.get(id);
	if (!cmd) throw new Error(`no command ${id}`);
	return cmd;
}

const sbPath = (id: string) => `/v1/sandboxes/${id}`;

describe("contract check", () => {
	it("catches a response that does not fit the document", async () => {
		api.script.badResponse = { path: /GET \/v1\/me$/, body: { nope: true } };
		const r = await call("GET", "/v1/me");
		expect(r.status).toBe(200);
		expect(api.contractErrors.length).toBeGreaterThan(0);
		expect(api.contractErrors.join("\n")).toContain("GET /v1/me");
	});

	it("catches a request that does not fit, and answers it 400", async () => {
		const r = await call("POST", "/v1/sandboxes", { body: { failFast: true } });
		expect(r.status).toBe(400);
		expect(r.json.error.code).toBe("validation");
		expect(api.contractErrors.join("\n")).toContain("failFast");
		api.contractErrors.length = 0;
		await call("GET", "/v1/sandboxes?stat=ready");
		expect(api.contractErrors.join("\n")).toContain(
			"unknown query parameter stat",
		);
	});

	it("catches a stray enum value in a response (enums are strict)", async () => {
		api.script.badResponse = {
			path: /GET \/v1\/sizes$/,
			body: { data: [{ slug: "x", vcpu: "two", memoryMb: 1 }] },
		};
		await call("GET", "/v1/sizes");
		expect(api.contractErrors.join("\n")).toContain("vcpu");
	});

	it("validates NDJSON frames against the frame schemas", () => {
		const contract = new Contract();
		expect(contract.validateFrame({ type: "heartbeat" })).toEqual([]);
		expect(
			contract.validateFrame({
				type: "exit",
				status: "exited",
				exitCode: 0,
				signal: null,
				reason: null,
				outputTruncated: null,
				stdoutOffset: 1,
				stderrOffset: 0,
			}),
		).toEqual([]);
		expect(contract.validateFrame({ type: "stdout", offset: 0 })).not.toEqual(
			[],
		);
		expect(
			contract.validateFrame({
				type: "exit",
				status: "weird",
				exitCode: 0,
				signal: null,
				reason: null,
				outputTruncated: null,
				stdoutOffset: 1,
				stderrOffset: 0,
			}),
		).not.toEqual([]);
	});
});

describe("auth and teams", () => {
	it("rejects missing and unknown bearers with the error envelope", async () => {
		const none = await call("GET", "/v1/me", { token: null });
		expect(none.status).toBe(401);
		expect(none.json.error).toMatchObject({
			code: "unauthorized",
			retryable: false,
		});
		expect(none.json.error.requestId).toBe(none.headers.get("Request-Id"));
		const bad = await call("GET", "/v1/me", { token: "nope" });
		expect(bad.status).toBe(401);
		expect(bad.json.error.details.reason).toBe("invalid_token");
		expect(api.contractErrors).toEqual([]);
	});

	it("answers 403 user_disabled, and token_expired once", async () => {
		api.tokens.set("t_off", {
			kind: "oidc",
			scopes: ["sandboxes:read"],
			teamId: "team_fake",
			disabled: true,
		});
		const off = await call("GET", "/v1/me", { token: "t_off" });
		expect(off.status).toBe(403);
		expect(off.json.error).toMatchObject({
			code: "forbidden",
			details: { reason: "user_disabled" },
		});
		api.script.expireTokenOnce = FAKE_TOKENS.oidc;
		const first = await call("GET", "/v1/me", { token: FAKE_TOKENS.oidc });
		expect(first.status).toBe(401);
		expect(first.json.error.code).toBe("token_expired");
		const second = await call("GET", "/v1/me", { token: FAKE_TOKENS.oidc });
		expect(second.status).toBe(200);
		expect(api.contractErrors).toEqual([]);
	});

	it("selects the team of a person by Sbx-Team", async () => {
		api.tokens.set("t_two", {
			kind: "oidc",
			scopes: ["sandboxes:read", "sandboxes:write"],
			teamId: FAKE_TEAM,
			teams: [OTHER_TEAM],
		});
		const own = await createReady();
		const other = { "Sbx-Team": OTHER_TEAM };
		const me = await call("GET", "/v1/me", { token: "t_two", headers: other });
		expect(me.status).toBe(200);
		expect(me.json.team.id).toBe(OTHER_TEAM);
		expect(me.json.teams.map((t: Json) => t.id)).toEqual([
			FAKE_TEAM,
			OTHER_TEAM,
		]);
		const dflt = await call("GET", "/v1/me", { token: "t_two" });
		expect(dflt.json.team.id).toBe(FAKE_TEAM);
		// The sandbox of the default team is not visible from the other one.
		const hidden = await call("GET", sbPath(own), {
			token: "t_two",
			headers: other,
		});
		expect(hidden.status).toBe(404);
		const seen = await call("GET", sbPath(own), { token: "t_two" });
		expect(seen.status).toBe(200);
		const stranger = await call("GET", "/v1/me", {
			token: "t_two",
			headers: { "Sbx-Team": "team_nobody" },
		});
		expect(stranger.status).toBe(403);
		expect(stranger.json.error.code).toBe("team_forbidden");
		const malformed = await call("GET", "/v1/me", {
			token: "t_two",
			headers: { "Sbx-Team": "nope" },
		});
		expect(malformed.status).toBe(400);
		expect(malformed.json.error.code).toBe("validation");
		expect(api.contractErrors).toEqual([]);
	});

	it("rejects a team key with another team in Sbx-Team", async () => {
		const same = await call("GET", "/v1/me", {
			headers: { "Sbx-Team": FAKE_TEAM },
		});
		expect(same.status).toBe(200);
		const other = await call("GET", "/v1/me", {
			headers: { "Sbx-Team": OTHER_TEAM },
		});
		expect(other.status).toBe(403);
		expect(other.json.error).toMatchObject({
			code: "team_forbidden",
			message: "the API key belongs to another team than Sbx-Team",
		});
		// A bad credential is a 401 whatever the team says.
		const bad = await call("GET", "/v1/me", {
			token: "nope",
			headers: { "Sbx-Team": "nope" },
		});
		expect(bad.status).toBe(401);
		expect(api.contractErrors).toEqual([]);
	});

	it("reports a team key in /v1/me with its scopes", async () => {
		const r = await call("GET", "/v1/me", { token: FAKE_TOKENS.readOnly });
		expect(r.status).toBe(200);
		expect(r.json.auth.kind).toBe("team_key");
		expect(r.json.auth.apiKeyId).toBe("key_fake_ro");
		expect(r.json.auth.scopes).toContain("sandboxes:read");
		expect(r.json.auth.scopes).not.toContain("sandboxes:write");
		expect(r.json.user).toBeNull();
		const oidc = await call("GET", "/v1/me", { token: FAKE_TOKENS.oidc });
		expect(oidc.json.auth.kind).toBe("oidc");
		expect(oidc.json.user.email).toBe("user@example.com");
		expect(api.contractErrors).toEqual([]);
	});

	it("enforces scopes with details.requiredScope", async () => {
		const w = await call("POST", "/v1/sandboxes", {
			token: FAKE_TOKENS.readOnly,
			body: {},
		});
		expect(w.status).toBe(403);
		expect(w.json.error).toMatchObject({
			code: "forbidden",
			details: { requiredScope: "sandboxes:write" },
		});
		const r = await call("GET", "/v1/sandboxes", {
			token: FAKE_TOKENS.readOnly,
		});
		expect(r.status).toBe(200);
		expect(api.contractErrors).toEqual([]);
	});

	it("hides another team's sandbox behind 404 not_found", async () => {
		const id = await createReady();
		for (const [m, p] of [
			["GET", sbPath(id)],
			["GET", `${sbPath(id)}/ports`],
			["POST", `${sbPath(id)}/stop`],
			["GET", `${sbPath(id)}/files/stat?path=/`],
		] as const) {
			const r = await call(m, p, { token: FAKE_TOKENS.otherTeam });
			expect(r.status, `${m} ${p}`).toBe(404);
			expect(r.json.error.code).toBe("not_found");
		}
		const list = await call("GET", "/v1/sandboxes", {
			token: FAKE_TOKENS.otherTeam,
		});
		expect(list.json.data).toEqual([]);
		expect(api.contractErrors).toEqual([]);
	});

	it("injects a failure once with failNext", async () => {
		api.script.failNext = {
			path: /GET \/v1\/limits$/,
			status: 503,
			code: "agent_unavailable",
			retryable: true,
		};
		const r = await call("GET", "/v1/limits");
		expect(r.status).toBe(503);
		expect(r.json.error).toMatchObject({
			code: "agent_unavailable",
			retryable: true,
		});
		expect(r.headers.get("Retry-After")).toBe("1");
		expect((await call("GET", "/v1/limits")).status).toBe(200);
		expect(api.contractErrors).toEqual([]);
	});

	it("serves no desktop routes with noDesktopRoutes: the plain 404 of an unknown route", async () => {
		const id = await createReady({ template: "linux-desktop" });
		api.script.noDesktopRoutes = true;
		const r = await call("GET", `${sbPath(id)}/desktop`);
		expect(r.status).toBe(404);
		expect(r.json.error.code).toBe("not_found");
		expect(r.json.error.message).toContain("no route for GET");
		expect(api.contractErrors).toEqual([]);
	});
});

describe("catalog", () => {
	it("lists the templates with capabilities and sizes", async () => {
		const t = await call("GET", "/v1/templates");
		const bySlug = Object.fromEntries(
			t.json.data.map((x: Json) => [x.slug, x]),
		);
		expect(bySlug.linux.capabilities).toEqual(["exec", "files", "ssh"]);
		expect(bySlug["linux-desktop"].capabilities).toContain("desktop");
		expect(bySlug.windows.os).toBe("windows");
		const s = await call("GET", "/v1/sizes");
		expect(s.json.data.map((x: Json) => x.slug)).toContain("2gb");
		expect(api.contractErrors).toEqual([]);
	});

	it("reports limits with usage and per-size reasons", async () => {
		await createReady({ size: "8gb" });
		const l = await call("GET", "/v1/limits");
		expect(l.json.usage).toMatchObject({ activeSandboxes: 1, ramMb: 8192 });
		expect(l.json.remaining.activeSandboxes).toBe(
			l.json.quota.maxActiveSandboxes - 1,
		);
		expect(l.json.canCreate).toBe(true);
		expect(api.contractErrors).toEqual([]);
	});

	it("refuses a create over the quota with quota_exceeded", async () => {
		await api.close();
		api = await startFakeApi({
			readyAfterMs: 10,
			quota: { maxActiveSandboxes: 1 },
		});
		await createReady();
		const r = await call("POST", "/v1/sandboxes", { body: {} });
		expect(r.status).toBe(403);
		expect(r.json.error).toMatchObject({
			code: "quota_exceeded",
			details: { limit: 1, current: 1 },
		});
		const l = await call("GET", "/v1/limits");
		expect(l.json.canCreate).toBe(false);
		expect(l.json.templates[0].sizes[0]).toMatchObject({
			allowed: false,
			reason: "quota_active_sandboxes",
		});
		expect(api.contractErrors).toEqual([]);
	});
});

describe("sandboxes", () => {
	it("creates, becomes ready and long-polls without waiting once it is", async () => {
		const c = await call("POST", "/v1/sandboxes", {
			body: { labels: { a: "1" }, ttlSeconds: 600 },
		});
		expect(c.json.sandbox).toMatchObject({
			state: "creating",
			template: "linux",
			size: "2gb",
		});
		expect(c.json.operation).toMatchObject({
			kind: "create",
			state: "running",
		});
		const id = c.json.sandbox.id;
		const t0 = Date.now();
		const ready = await call(
			"GET",
			`${sbPath(id)}?waitFor=ready,stopped&waitSeconds=5`,
		);
		expect(ready.json.state).toBe("ready");
		expect(ready.json.deadlineAt).not.toBeNull();
		expect(Date.now() - t0).toBeLessThan(1000);
		const t1 = Date.now();
		await call("GET", `${sbPath(id)}?waitFor=ready&waitSeconds=5`);
		expect(Date.now() - t1).toBeLessThan(500);
		const op = await call(
			"GET",
			`/v1/operations/${c.json.operation.id}?waitSeconds=5`,
		);
		expect(op.json.state).toBe("succeeded");
		expect(api.contractErrors).toEqual([]);
	});

	it("times out a long-poll with the current state", async () => {
		api.state.readyAfterMs = 60_000;
		const c = await call("POST", "/v1/sandboxes", { body: {} });
		const r = await call(
			"GET",
			`${sbPath(c.json.sandbox.id)}?waitFor=ready&waitSeconds=1`,
		);
		expect(r.status).toBe(200);
		expect(r.json.state).toBe("creating");
		expect(api.contractErrors).toEqual([]);
	});

	it("never answers a long-poll when the script is silent", async () => {
		const id = await createReady();
		api.script.silent = true;
		const ctl = new AbortController();
		const p = fetch(`${api.url}${sbPath(id)}?waitFor=stopped&waitSeconds=1`, {
			headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
			signal: ctl.signal,
		});
		const raced = await Promise.race([
			p.then(() => "answered"),
			new Promise((r) => setTimeout(() => r("silent"), 1500)),
		]);
		expect(raced).toBe("silent");
		ctl.abort();
		await p.catch(() => {});
	});

	it("resolves by slug and filters lists with paging", async () => {
		const a = await createReady({ slug: "alpha", labels: { team: "x" } });
		await createReady({
			slug: "beta",
			labels: { team: "y" },
			template: "linux-desktop",
		});
		await createReady({ slug: "gamma", labels: { team: "x" } });
		expect((await call("GET", "/v1/sandboxes/alpha")).json.id).toBe(a);
		const byLabel = await call("GET", "/v1/sandboxes?label=team%3Dx");
		expect(byLabel.json.data.map((s: Json) => s.slug)).toEqual([
			"gamma",
			"alpha",
		]);
		const byTemplate = await call(
			"GET",
			"/v1/sandboxes?template=linux-desktop",
		);
		expect(byTemplate.json.data.map((s: Json) => s.slug)).toEqual(["beta"]);
		expect((await call("GET", "/v1/sandboxes?q=al")).json.data[0].slug).toBe(
			"alpha",
		);
		expect(
			(await call("GET", "/v1/sandboxes?state=stopped")).json.data,
		).toEqual([]);
		const p1 = await call("GET", "/v1/sandboxes?limit=2");
		expect(p1.json.data.map((s: Json) => s.slug)).toEqual(["gamma", "beta"]);
		const p2 = await call(
			"GET",
			`/v1/sandboxes?limit=2&cursor=${p1.json.nextCursor}`,
		);
		expect(p2.json.data.map((s: Json) => s.slug)).toEqual(["alpha"]);
		expect(p2.json.nextCursor).toBeNull();
		expect(
			(await call("GET", "/v1/sandboxes?cursor=zzz")).json.error.code,
		).toBe("invalid_cursor");
		expect((await call("GET", "/v1/sandboxes?state=bogus")).status).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("replays create with the same Idempotency-Key and refuses another body", async () => {
		const h = { "Idempotency-Key": "k-1" };
		const first = await call("POST", "/v1/sandboxes", {
			body: { slug: "one" },
			headers: h,
		});
		expect(first.headers.get("Idempotency-Replayed")).toBeNull();
		const again = await call("POST", "/v1/sandboxes", {
			body: { slug: "one" },
			headers: h,
		});
		expect(again.status).toBe(202);
		expect(again.headers.get("Idempotency-Replayed")).toBe("true");
		expect(again.json.sandbox.id).toBe(first.json.sandbox.id);
		expect(api.state.sandboxes.size).toBe(1);
		const other = await call("POST", "/v1/sandboxes", {
			body: { slug: "two" },
			headers: h,
		});
		expect(other.status).toBe(409);
		expect(other.json.error.code).toBe("idempotency_key_reused");
		expect(api.contractErrors).toEqual([]);
	});

	it("validates template, size, slug and snapshot on create", async () => {
		expect(
			(await call("POST", "/v1/sandboxes", { body: { template: "nope" } })).json
				.error.code,
		).toBe("template_unavailable");
		expect(
			(await call("POST", "/v1/sandboxes", { body: { size: "99gb" } })).json
				.error.code,
		).toBe("template_unavailable");
		await call("POST", "/v1/sandboxes", { body: { slug: "taken" } });
		expect(
			(await call("POST", "/v1/sandboxes", { body: { slug: "taken" } })).json
				.error.code,
		).toBe("slug_taken");
		expect(
			(await call("POST", "/v1/sandboxes", { body: { slug: "Bad Slug" } }))
				.status,
		).toBe(400);
		expect(
			(
				await call("POST", "/v1/sandboxes", {
					body: { from: { snapshot: "none" } },
				})
			).json.error.code,
		).toBe("snapshot_not_found");
		expect(
			(await call("POST", "/v1/sandboxes", { body: { environment: "dev" } }))
				.status,
		).toBe(404);
		expect(
			(
				await call("POST", "/v1/sandboxes", {
					body: { excludeOwnerSecrets: true },
				})
			).status,
		).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("ends a create in error when the script says so", async () => {
		api.script.createFails = {
			code: "boot_failed",
			message: "the VM did not boot",
		};
		const c = await call("POST", "/v1/sandboxes", { body: {} });
		const r = await call(
			"GET",
			`${sbPath(c.json.sandbox.id)}?waitFor=ready&waitSeconds=5`,
		);
		expect(r.json.state).toBe("error");
		expect(r.json.error).toEqual({
			code: "boot_failed",
			message: "the VM did not boot",
		});
		const op = await call("GET", `/v1/operations/${c.json.operation.id}`);
		expect(op.json).toMatchObject({
			state: "failed",
			error: { code: "boot_failed" },
		});
		expect(api.contractErrors).toEqual([]);
	});

	it("updates name, labels (replaced) and ttl, and refuses a taken slug", async () => {
		const id = await createReady({ labels: { a: "1" }, slug: "up" });
		await createReady({ slug: "other" });
		const r = await call("PATCH", sbPath(id), {
			body: {
				name: "n",
				labels: { b: "2" },
				ttlSeconds: 300,
				idleTimeoutSeconds: 120,
			},
		});
		expect(r.json).toMatchObject({
			name: "n",
			labels: { b: "2" },
			ttlSeconds: 300,
			idleTimeoutSeconds: 120,
		});
		expect(r.json.deadlineAt).not.toBeNull();
		const cleared = await call("PATCH", sbPath(id), {
			body: { ttlSeconds: null },
		});
		expect(cleared.json.deadlineAt).toBeNull();
		expect(
			(await call("PATCH", sbPath(id), { body: { slug: "other" } })).json.error
				.code,
		).toBe("slug_taken");
		expect(
			(await call("PATCH", sbPath(id), { body: { bogus: 1 } })).status,
		).toBe(400);
		expect(api.contractErrors.filter((e) => !e.includes("bogus"))).toEqual([]);
	});

	it("stops, resumes, recovers and forks with operations", async () => {
		const id = await createReady({ slug: "life", ttlSeconds: 900 });
		const stop = await call("POST", `${sbPath(id)}/stop`);
		expect(stop.status).toBe(202);
		expect(stop.json.sandbox.state).toBe("stopping");
		const again = await call("POST", `${sbPath(id)}/stop`);
		expect(again.json.operation.id).toBe(stop.json.operation.id);
		const resumeEarly = await call("POST", `${sbPath(id)}/resume`);
		expect(resumeEarly.json.error).toMatchObject({
			code: "operation_in_progress",
			retryable: true,
		});
		const stopped = await call(
			"GET",
			`${sbPath(id)}?waitFor=stopped&waitSeconds=5`,
		);
		expect(stopped.json).toMatchObject({
			state: "stopped",
			stopReason: "user",
		});
		expect((await call("POST", `${sbPath(id)}/stop`)).json.error).toMatchObject(
			{ code: "invalid_state", details: { state: "stopped" } },
		);
		expect((await call("POST", `${sbPath(id)}/recover`)).json.error.code).toBe(
			"invalid_state",
		);
		const resume = await call("POST", `${sbPath(id)}/resume`, {
			body: { env: { A: "1", B: null } },
		});
		expect(resume.json.sandbox.state).toBe("starting");
		expect(
			(await call("GET", `${sbPath(id)}?waitFor=ready&waitSeconds=5`)).json
				.state,
		).toBe("ready");
		const rec = await call("POST", `${sbPath(id)}/recover`);
		expect(rec.json.operation.kind).toBe("recover");
		await call("GET", `/v1/operations/${rec.json.operation.id}?waitSeconds=5`);

		const fork = await call("POST", `${sbPath(id)}/fork`, {
			body: { slug: "life-copy", labels: { f: "1" } },
			headers: { "Idempotency-Key": "fk" },
		});
		expect(fork.status).toBe(202);
		expect(fork.json.sandbox).toMatchObject({
			slug: "life-copy",
			state: "creating",
			origin: { kind: "fork", sandboxId: id },
		});
		expect(fork.json.operation.kind).toBe("create");
		expect(fork.json.sourceOperation).toMatchObject({
			kind: "fork",
			sandboxId: id,
		});
		const replay = await call("POST", `${sbPath(id)}/fork`, {
			body: { slug: "life-copy", labels: { f: "1" } },
			headers: { "Idempotency-Key": "fk" },
		});
		expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
		expect(replay.json.sandbox.id).toBe(fork.json.sandbox.id);
		expect(
			(
				await call(
					"GET",
					`${sbPath(fork.json.sandbox.id)}?waitFor=ready&waitSeconds=5`,
				)
			).json.state,
		).toBe("ready");
		expect(api.contractErrors).toEqual([]);
	});

	it("copies the files on fork", async () => {
		const id = await createReady();
		await call("PUT", `${sbPath(id)}/files/content?path=a.txt`, {
			raw: "hello",
		});
		const fork = await call("POST", `${sbPath(id)}/fork`, { body: {} });
		const copy = fork.json.sandbox.id as string;
		await call("GET", `${sbPath(copy)}?waitFor=ready&waitSeconds=5`);
		const r = await call(
			"GET",
			`${sbPath(copy)}/files/content?path=/home/user/a.txt`,
		);
		expect(new TextDecoder().decode(r.bytes)).toBe("hello");
		expect(api.contractErrors).toEqual([]);
	});

	it("deletes only with a matching Sbx-Confirm-Delete (id or slug)", async () => {
		const id = await createReady({ slug: "doomed" });
		const none = await call("DELETE", sbPath(id));
		expect(none.status).toBe(428);
		expect(none.json.error).toMatchObject({
			code: "confirmation_required",
			details: { reason: "missing" },
		});
		const wrong = await call("DELETE", sbPath(id), {
			headers: { "Sbx-Confirm-Delete": "sb_other" },
		});
		expect(wrong.status).toBe(428);
		expect(wrong.json.error.details.reason).toBe("mismatch");
		expect(api.state.sandboxes.get(id)?.state).toBe("ready");
		const ok = await call("DELETE", "/v1/sandboxes/doomed", {
			headers: { "Sbx-Confirm-Delete": "doomed" },
		});
		expect(ok.status).toBe(202);
		expect(ok.json.sandbox.state).toBe("deleting");
		expect(ok.json.operation.kind).toBe("delete");
		// A long-poll ends at `deleting` already (S7 §5.10): follow the operation.
		await call("GET", `/v1/operations/${ok.json.operation.id}?waitSeconds=5`);
		expect((await call("GET", sbPath(id))).json.state).toBe("deleted");
		expect((await call("GET", "/v1/sandboxes/doomed")).status).toBe(404);
		const repeat = await call("DELETE", sbPath(id), {
			headers: { "Sbx-Confirm-Delete": id },
		});
		expect(repeat.status).toBe(200);
		expect(repeat.json.operation).toBeNull();
		expect((await call("GET", "/v1/sandboxes")).json.data).toEqual([]);
		expect(
			(await call("GET", "/v1/sandboxes?state=deleted")).json.data,
		).toHaveLength(1);
		expect(api.contractErrors).toEqual([]);
	});

	it("drives a full SDK scenario with no contract error", async () => {
		const sbx = new Sbx({ baseUrl: api.url, apiKey: FAKE_TOKENS.full });
		const sb = await sbx.sandboxes.create(
			{ template: "linux" },
			{ wait: true },
		);
		expect(sb.data.state).toBe("ready");
		const r = await sb.exec("echo hello");
		expect(r.stdout).toBe("hello\n");
		expect(r.exitCode).toBe(0);
		await sb.files.writeText("notes/a.txt", "one");
		expect(await sb.files.readText("/home/user/notes/a.txt")).toBe("one");
		const names: string[] = [];
		for await (const f of sb.files.list("notes")) names.push(f.name);
		expect(names).toEqual(["a.txt"]);
		const hosted = await sb.ports.host(3000);
		expect(hosted.access).toBe("token");
		expect(hosted.token).toMatch(/^sbxp_/);
		expect((await sb.ports.list()).hosted).toHaveLength(1);
		await sb.ports.unhost(3000);
		await sb.stop({ wait: true });
		expect((await sbx.sandboxes.get(sb.id)).data.state).toBe("stopped");
		await sb.delete({ wait: true });
		expect((await sbx.me()).auth.kind).toBe("team_key");
		expect(await sbx.limits()).toHaveProperty("quota");
		expect((await sbx.templates()).length).toBe(3);
		expect(api.contractErrors).toEqual([]);
		expect(api.journal).toContain(`DELETE /v1/sandboxes/${sb.id}`);
	});
});

describe("commands", () => {
	async function ready() {
		return createReady();
	}

	it("runs the scenario commands", () => {
		// documented patterns: emit is exact, 20 bytes per unit
		expect(Buffer.byteLength(EMIT_UNIT)).toBe(20);
		expect(emitPattern(25).length).toBe(25);
		expect(emitPattern(40).toString()).toBe(EMIT_UNIT + EMIT_UNIT);
	});

	it("streams started, output and exit with Sbx-Command-Id and base64", async () => {
		const id = await ready();
		const r = await call("POST", `${sbPath(id)}/commands`, {
			body: {
				command: "fake:emit 40:40:0",
				mode: "stream",
				encoding: "base64",
			},
		});
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/x-ndjson");
		const fs = frames(r);
		expect(fs[0]).toMatchObject({ type: "started", encoding: "base64" });
		expect(fs[0]?.replayed).toBeUndefined();
		expect(r.headers.get("Sbx-Command-Id")).toBe(fs[0]?.commandId);
		const data = Buffer.concat(
			fs
				.filter((f) => f.type === "stdout")
				.map((f) => Buffer.from(f.data, "base64")),
		);
		expect(data.toString()).toBe(emitPattern(40).toString());
		expect(fs.at(-1)).toMatchObject({
			type: "exit",
			status: "exited",
			exitCode: 0,
			stdoutOffset: 40,
			stderrOffset: 0,
		});
		expect(api.contractErrors).toEqual([]);
	});

	it("replays a stream command with started.replayed and the header; reuse is 409", async () => {
		const id = await ready();
		const h = { "Idempotency-Key": "run-1" };
		const body = { command: "echo once", mode: "stream" };
		const a = await call("POST", `${sbPath(id)}/commands`, {
			body,
			headers: h,
		});
		const b = await call("POST", `${sbPath(id)}/commands`, {
			body,
			headers: h,
		});
		expect(b.headers.get("Idempotency-Replayed")).toBe("true");
		expect(frames(b)[0]).toMatchObject({ type: "started", replayed: true });
		expect(frames(b)[0]?.commandId).toBe(frames(a)[0]?.commandId);
		expect(frames(b).filter((f) => f.type === "stdout")).toHaveLength(1);
		expect([...api.state.commands.values()]).toHaveLength(1);
		const reuse = await call("POST", `${sbPath(id)}/commands`, {
			body: { ...body, command: "echo twice" },
			headers: h,
		});
		expect(reuse.status).toBe(409);
		expect(reuse.json.error.code).toBe("idempotency_key_reused");
		expect(api.contractErrors).toEqual([]);
	});

	it("keeps an Idempotency-Key apart per sandbox (same key on two sandboxes is a reuse)", async () => {
		const a = await ready();
		const b = await createReady();
		const h = { "Idempotency-Key": "shared" };
		const body = { command: "echo x", mode: "detached" };
		expect(
			(await call("POST", `${sbPath(a)}/commands`, { body, headers: h }))
				.status,
		).toBe(201);
		const r = await call("POST", `${sbPath(b)}/commands`, { body, headers: h });
		expect(r.status).toBe(409);
		expect(r.json.error.code).toBe("idempotency_key_reused");
	});

	it("starts detached (201, replay 200) and reads one command with stream sizes", async () => {
		const id = await ready();
		const h = { "Idempotency-Key": "d-1" };
		const body = {
			argv: ["echo", "a", "b"],
			mode: "detached",
			tags: { t: "1" },
			env: { K: "v" },
			cwd: "proj",
		};
		const a = await call("POST", `${sbPath(id)}/commands`, {
			body,
			headers: h,
		});
		expect(a.status).toBe(201);
		expect(a.json).toMatchObject({
			mode: "detached",
			argv: ["echo", "a", "b"],
			command: null,
			cwd: "/home/user/proj",
			envKeys: ["K"],
			tags: { t: "1" },
		});
		const b = await call("POST", `${sbPath(id)}/commands`, {
			body,
			headers: h,
		});
		expect(b.status).toBe(200);
		expect(b.headers.get("Idempotency-Replayed")).toBe("true");
		expect(b.json.id).toBe(a.json.id);
		const one = await call("GET", `${sbPath(id)}/commands/${a.json.id}`);
		expect(one.json.streams.stdout).toEqual({
			sizeBytes: 4,
			availableFromBytes: 0,
			endBytes: 4,
		});
		expect(one.json).toMatchObject({ status: "exited", exitCode: 0 });
		expect(api.contractErrors).toEqual([]);
	});

	it("runs sync and validates command/argv and the timeout", async () => {
		const id = await ready();
		const r = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:stderr oops" },
		});
		expect(r.json).toMatchObject({
			stdout: "",
			stderr: "oops\n",
			stdoutFrom: 0,
			command: { status: "exited" },
		});
		expect(
			(
				await call("POST", `${sbPath(id)}/commands`, {
					body: { command: "a", argv: ["a"] },
				})
			).status,
		).toBe(400);
		expect(
			(await call("POST", `${sbPath(id)}/commands`, { body: {} })).status,
		).toBe(400);
		expect(
			(
				await call("POST", `${sbPath(id)}/commands`, {
					body: { command: "a", timeoutSeconds: 601 },
				})
			).status,
		).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("lists commands with status filter and paging, and 404s a foreign command", async () => {
		const id = await ready();
		for (const c of ["echo 1", "echo 2", "fake:sleep 30"]) {
			await call("POST", `${sbPath(id)}/commands`, {
				body: { command: c, mode: "detached" },
			});
		}
		const running = await call("GET", `${sbPath(id)}/commands?status=running`);
		expect(running.json.data.map((c: Json) => c.command)).toEqual([
			"fake:sleep 30",
		]);
		const page = await call("GET", `${sbPath(id)}/commands?limit=2`);
		expect(page.json.data).toHaveLength(2);
		const rest = await call(
			"GET",
			`${sbPath(id)}/commands?limit=2&cursor=${page.json.nextCursor}`,
		);
		expect(rest.json.data.map((c: Json) => c.command)).toEqual(["echo 1"]);
		expect(
			(await call("GET", `${sbPath(id)}/commands?status=bogus`)).status,
		).toBe(400);
		const other = await createReady();
		expect(
			(
				await call(
					"GET",
					`${sbPath(other)}/commands/${running.json.data[0].id}`,
				)
			).status,
		).toBe(404);
		expect(api.contractErrors).toEqual([]);
	});

	it("reads output by offsets with Sbx headers, truncation and 416", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:emit 100:100:0", mode: "detached" },
		});
		const cmdPath = `${sbPath(id)}/commands/${c.json.id}`;
		const all = await call("GET", `${cmdPath}/output`);
		expect(all.headers.get("content-type")).toBe("application/octet-stream");
		expect(all.bytes).toEqual(new Uint8Array(emitPattern(100)));
		expect(all.headers.get("Sbx-Offset")).toBe("0");
		expect(all.headers.get("Sbx-Next-Offset")).toBe("100");
		expect(all.headers.get("Sbx-Stream-End")).toBe("100");
		const part = await call("GET", `${cmdPath}/output?offset=10&limit=20`);
		expect(part.bytes).toEqual(
			new Uint8Array(emitPattern(100).subarray(10, 30)),
		);
		expect(part.headers.get("Sbx-Next-Offset")).toBe("30");
		commandOf(c.json.id).availableFrom.stdout = 50;
		const trunc = await call("GET", `${cmdPath}/output?offset=10`);
		expect(trunc.headers.get("Sbx-Truncated")).toBe("true");
		expect(trunc.headers.get("Sbx-Offset")).toBe("50");
		expect(trunc.headers.get("Sbx-Available-From")).toBe("50");
		expect((await call("GET", `${cmdPath}/output?offset=101`)).status).toBe(
			416,
		);
		expect((await call("GET", `${cmdPath}/output?stream=pty`)).status).toBe(
			400,
		);
		const err = await call("GET", `${cmdPath}/output?stream=stderr`);
		expect(err.bytes.length).toBe(0);
		expect(api.contractErrors).toEqual([]);
	});

	it("streams from offsets with attached, truncated, tailBytes and follow=false", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:emit 100:100:0", mode: "detached" },
		});
		const base = `${sbPath(id)}/commands/${c.json.id}/stream`;
		const full = frames(
			await call("GET", `${base}?follow=false&encoding=base64`),
		);
		expect(full[0]).toMatchObject({
			type: "attached",
			stdoutOffset: 0,
			stderrOffset: 0,
			encoding: "base64",
		});
		expect(full.at(-1)).toMatchObject({ type: "exit", stdoutOffset: 100 });
		const tail = frames(
			await call("GET", `${base}?tailBytes=30&encoding=base64`),
		);
		expect(tail[0]).toMatchObject({ stdoutOffset: 70 });
		expect(Buffer.from(tail[1]?.data, "base64")).toEqual(
			emitPattern(100).subarray(70),
		);
		commandOf(c.json.id).availableFrom.stdout = 40;
		const trunc = frames(
			await call("GET", `${base}?stdoutOffset=10&follow=false`),
		);
		expect(trunc[1]).toEqual({
			type: "truncated",
			stream: "stdout",
			availableFrom: 40,
		});
		expect(trunc[2]).toMatchObject({ type: "stdout", offset: 40 });
		expect((await call("GET", `${base}?stdoutOffset=101`)).status).toBe(416);
		expect((await call("GET", `${base}?ptyOffset=1`)).status).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("sends heartbeat frames while a command is silent, then exit", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:sleep 0.3", mode: "detached" },
		});
		const r = await call(
			"GET",
			`${sbPath(id)}/commands/${c.json.id}/stream?follow=true`,
		);
		const types = frames(r).map((f) => f.type);
		expect(types[0]).toBe("attached");
		expect(types).toContain("heartbeat");
		expect(types.at(-1)).toBe("exit");
		// retention: bytes dropped earlier answer with a truncated frame in follow mode
		const out = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:emit 60:60:0", mode: "detached" },
		});
		commandOf(out.json.id).availableFrom.stdout = 20;
		const t = frames(
			await call(
				"GET",
				`${sbPath(id)}/commands/${out.json.id}/stream?follow=true`,
			),
		);
		expect(t.map((f) => f.type)).toEqual([
			"attached",
			"truncated",
			"stdout",
			"exit",
		]);
		expect(api.contractErrors).toEqual([]);
	});

	it("keeps utf8 frames on character boundaries and counts offsets in bytes", async () => {
		const id = await ready();
		// 7-byte chunks cut the 2-, 3- and 4-byte characters of the unit
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:emit 200:7:0", mode: "stream" },
		});
		const out = frames(c).filter((f) => f.type === "stdout");
		let at = 0;
		let text = "";
		for (const f of out) {
			expect(f.offset).toBe(at);
			expect(f.data).not.toContain("�");
			at = f.nextOffset;
			text += f.data;
		}
		expect(at).toBe(200);
		expect(text).toBe(emitPattern(200).toString());
		expect(api.contractErrors).toEqual([]);
	});

	it("emits ANSI, Unicode tags and a forged fence end with fake:inject", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:inject", mode: "stream" },
		});
		const text = frames(c)
			.filter((f) => f.type === "stdout")
			.map((f) => f.data)
			.join("");
		expect(text).toContain("\u001b[31m");
		expect(text).toContain(String.fromCodePoint(0xe0041));
		expect(text).toContain(INJECT_FENCE_END);
	});

	it("exits with a code, times out, and is killed by kill and signal", async () => {
		const id = await ready();
		const post = (command: string, extra: Record<string, unknown> = {}) =>
			call("POST", `${sbPath(id)}/commands`, {
				body: { command, mode: "detached", ...extra },
			});
		const exit3 = await post("fake:exit 3");
		expect(
			(await call("GET", `${sbPath(id)}/commands/${exit3.json.id}`)).json,
		).toMatchObject({ status: "exited", exitCode: 3 });
		const slow = await post("fake:sleep 30", { timeoutSeconds: 1 });
		const run = await post("fake:sleep 30");
		const killed = await call(
			"POST",
			`${sbPath(id)}/commands/${run.json.id}/kill`,
			{ body: { graceMs: 100 } },
		);
		expect(killed.json).toMatchObject({
			status: "killed",
			signal: "SIGTERM",
			exitCode: null,
		});
		expect(api.journal).toContain(
			`POST ${sbPath(id)}/commands/${run.json.id}/kill`,
		);
		const again = await call(
			"POST",
			`${sbPath(id)}/commands/${run.json.id}/kill`,
		);
		expect(again.json.status).toBe("killed");
		const sig = await post("fake:sleep 30");
		const usr = await call(
			"POST",
			`${sbPath(id)}/commands/${sig.json.id}/signal`,
			{ body: { signal: "SIGUSR1" } },
		);
		expect(usr.json.status).toBe("running");
		const int = await call(
			"POST",
			`${sbPath(id)}/commands/${sig.json.id}/signal`,
			{ body: { signal: "SIGINT" } },
		);
		expect(int.json).toMatchObject({ status: "killed", signal: "SIGINT" });
		await new Promise((r) => setTimeout(r, 1200));
		expect(
			(await call("GET", `${sbPath(id)}/commands/${slow.json.id}`)).json,
		).toMatchObject({ status: "timed_out" });
		expect(api.contractErrors).toEqual([]);
	});

	it("cuts a stream once with breakStreamAfterBytes; the SDK reconnects without losing bytes", async () => {
		const sbx = new Sbx({ baseUrl: api.url, apiKey: FAKE_TOKENS.full });
		const sb = await sbx.sandboxes.create({}, { wait: true });
		api.script.breakStreamAfterBytes = 3000;
		const run = sb.run("fake:emit 20000:1000:0", { encoding: "base64" });
		const parts: Uint8Array[] = [];
		let exit: unknown;
		for await (const ev of run) {
			if (ev.type === "stdout") parts.push(ev.data);
			if (ev.type === "exit") exit = ev;
		}
		const got = Buffer.concat(parts);
		expect(createHash("sha256").update(got).digest("hex")).toBe(
			createHash("sha256").update(emitPattern(20000)).digest("hex"),
		);
		expect(exit).toMatchObject({ status: "exited", exitCode: 0 });
		expect(api.script.breakStreamAfterBytes).toBeUndefined();
		expect(
			api.journal.filter((j) => j.endsWith("/stream")).length,
		).toBeGreaterThanOrEqual(1);
		expect(api.contractErrors).toEqual([]);
	});

	it("holds the POST answer but starts the command at once; a retry with the key attaches to it", async () => {
		const id = await ready();
		api.script.holdCommandsPostMs = 400;
		const ctl = new AbortController();
		const h = { "Idempotency-Key": "slow-1" };
		const first = fetch(`${api.url}${sbPath(id)}/commands`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${FAKE_TOKENS.full}`,
				"Content-Type": "application/json",
				...h,
			},
			body: JSON.stringify({ command: "echo held", mode: "stream" }),
			signal: ctl.signal,
		});
		await new Promise((r) => setTimeout(r, 100));
		expect([...api.state.commands.values()]).toHaveLength(1);
		ctl.abort();
		await first.catch(() => {});
		const retry = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "echo held", mode: "stream" },
			headers: h,
		});
		expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
		expect([...api.state.commands.values()]).toHaveLength(1);
	});

	it("lets go of a followed stream when the client disconnects, and close() ends open streams", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:sleep 30", mode: "detached" },
		});
		const cmd = commandOf(c.json.id);
		const ctl = new AbortController();
		const res = await fetch(
			`${api.url}${sbPath(id)}/commands/${c.json.id}/stream`,
			{
				headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
				signal: ctl.signal,
			},
		);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read(); // the attached frame
		expect(cmd.waiters.size).toBe(1);
		ctl.abort();
		await reader.read().catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		expect(cmd.waiters.size).toBe(0);
		// a stream still open when the fake closes does not keep close() waiting
		const open = await fetch(
			`${api.url}${sbPath(id)}/commands/${c.json.id}/stream`,
			{
				headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
			},
		);
		await (open.body as ReadableStream<Uint8Array>).getReader().read();
		await api.close();
	});

	it("answers sandbox_not_ready for a stopped sandbox, but still lists commands", async () => {
		const id = await ready();
		const c = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "fake:sleep 30", mode: "detached" },
		});
		await call("POST", `${sbPath(id)}/stop`);
		await call("GET", `${sbPath(id)}?waitFor=stopped&waitSeconds=5`);
		const r = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "echo x" },
		});
		expect(r.status).toBe(409);
		expect(r.json.error).toMatchObject({
			code: "sandbox_not_ready",
			details: { state: "stopped" },
		});
		expect(
			(await call("GET", `${sbPath(id)}/commands/${c.json.id}/output`)).status,
		).toBe(409);
		const one = await call("GET", `${sbPath(id)}/commands/${c.json.id}`);
		expect(one.json.status).toBe("lost");
		expect(
			(await call("GET", `${sbPath(id)}/commands`)).json.data,
		).toHaveLength(1);
		expect(api.contractErrors).toEqual([]);
	});

	it("waits for a creating sandbox, then answers sandbox_starting when it takes too long", async () => {
		await api.close();
		api = await startFakeApi({ readyAfterMs: 60, startWaitMs: 5_000 });
		const c = await call("POST", "/v1/sandboxes", { body: {} });
		const id = c.json.sandbox.id;
		const r = await call("POST", `${sbPath(id)}/commands`, {
			body: { command: "echo early" },
		});
		expect(r.status).toBe(200);
		await api.close();
		api = await startFakeApi({ readyAfterMs: 60_000, startWaitMs: 100 });
		const slow = await call("POST", "/v1/sandboxes", { body: {} });
		const late = await call(
			"POST",
			`${sbPath(slow.json.sandbox.id)}/commands`,
			{ body: { command: "echo" } },
		);
		expect(late.status).toBe(409);
		expect(late.json.error).toMatchObject({
			code: "sandbox_starting",
			retryable: true,
		});
	});
});

describe("files", () => {
	it("writes atomically with mode, reads with Range (206) and sends the download headers", async () => {
		const id = await createReady();
		const w = await call(
			"PUT",
			`${sbPath(id)}/files/content?path=proj/run.sh&mode=0755`,
			{ raw: "0123456789" },
		);
		expect(w.status).toBe(200);
		expect(w.json).toMatchObject({
			path: "/home/user/proj/run.sh",
			name: "run.sh",
			type: "file",
			sizeBytes: 10,
			mode: 0o755,
		});
		const full = await call(
			"GET",
			`${sbPath(id)}/files/content?path=/home/user/proj/run.sh`,
		);
		expect(full.status).toBe(200);
		expect(full.headers.get("content-type")).toBe("application/octet-stream");
		expect(full.headers.get("Accept-Ranges")).toBe("bytes");
		expect(full.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(full.headers.get("Content-Disposition")).toContain("attachment");
		const get = (range: string) =>
			call("GET", `${sbPath(id)}/files/content?path=proj/run.sh`, {
				headers: { Range: range },
			});
		const mid = await get("bytes=2-5");
		expect(mid.status).toBe(206);
		expect(new TextDecoder().decode(mid.bytes)).toBe("2345");
		expect(mid.headers.get("Content-Range")).toBe("bytes 2-5/10");
		expect(new TextDecoder().decode((await get("bytes=7-")).bytes)).toBe("789");
		expect(new TextDecoder().decode((await get("bytes=-3")).bytes)).toBe("789");
		expect((await get("bytes=4-100")).headers.get("Content-Range")).toBe(
			"bytes 4-9/10",
		);
		const bad = await get("bytes=10-12");
		expect(bad.status).toBe(416);
		expect(bad.headers.get("Content-Range")).toBe("bytes */10");
		expect(bad.json.error.code).toBe("range_not_satisfiable");
		expect((await get("bytes=0-1,3-4")).status).toBe(200);
		expect(api.contractErrors).toEqual([]);
	});

	it("honours overwrite=false, makeParents=false, directories and missing paths", async () => {
		const id = await createReady();
		await call("PUT", `${sbPath(id)}/files/content?path=a.txt`, { raw: "1" });
		expect(
			(
				await call(
					"PUT",
					`${sbPath(id)}/files/content?path=a.txt&overwrite=false`,
					{ raw: "2" },
				)
			).json.error.code,
		).toBe("already_exists");
		expect(
			(
				await call(
					"PUT",
					`${sbPath(id)}/files/content?path=x/y/z.txt&makeParents=false`,
					{ raw: "2" },
				)
			).json.error.code,
		).toBe("path_not_found");
		expect(
			(
				await call("PUT", `${sbPath(id)}/files/content?path=/home/user`, {
					raw: "2",
				})
			).json.error.code,
		).toBe("is_directory");
		expect(
			(await call("GET", `${sbPath(id)}/files/content?path=/home/user`)).json
				.error.code,
		).toBe("is_directory");
		expect(
			(await call("GET", `${sbPath(id)}/files/content?path=nope`)).json.error
				.code,
		).toBe("path_not_found");
		expect(
			(
				await call("PUT", `${sbPath(id)}/files/content?path=a.txt&mode=999`, {
					raw: "2",
				})
			).status,
		).toBe(400);
		const empty = await call("PUT", `${sbPath(id)}/files/content?path=empty`, {
			raw: "",
		});
		expect(empty.json.sizeBytes).toBe(0);
		expect(api.contractErrors.filter((e) => !e.includes("mode"))).toEqual([]);
	});

	it("stats files, dirs and symlinks, and 404s path_not_found", async () => {
		const id = await createReady();
		const fs = api.state.fs(id);
		await fs.write("/home/user/real.txt", "data", {
			mtime: new Date("2024-01-02T03:04:05.000Z"),
		});
		await fs.symlink("/home/user/link", "real.txt");
		await fs.symlink("/home/user/abs", "/etc/passwd");
		const file = await call("GET", `${sbPath(id)}/files/stat?path=real.txt`);
		expect(file.json).toMatchObject({
			type: "file",
			sizeBytes: 4,
			modifiedAt: "2024-01-02T03:04:05.000Z",
			symlinkTarget: null,
		});
		const followed = await call("GET", `${sbPath(id)}/files/stat?path=link`);
		expect(followed.json).toMatchObject({
			type: "file",
			sizeBytes: 4,
			symlinkTarget: "real.txt",
		});
		const nofollow = await call(
			"GET",
			`${sbPath(id)}/files/stat?path=link&noFollow=true`,
		);
		expect(nofollow.json).toMatchObject({
			type: "symlink",
			symlinkTarget: "real.txt",
		});
		const dir = await call("GET", `${sbPath(id)}/files/stat?path=~`);
		expect(dir.json).toMatchObject({
			type: "dir",
			path: "/home/user",
			name: "user",
		});
		const missing = await call("GET", `${sbPath(id)}/files/stat?path=nope`);
		expect(missing.status).toBe(404);
		expect(missing.json.error.code).toBe("path_not_found");
		// an absolute link target stays inside the sandbox root, never the host
		expect(
			(await call("GET", `${sbPath(id)}/files/stat?path=abs`)).status,
		).toBe(404);
		expect(
			(await call("GET", `${sbPath(id)}/files/content?path=link`)).bytes,
		).toEqual(new TextEncoder().encode("data"));
		expect(api.contractErrors).toEqual([]);
	});

	it("lists with depth, hidden files, limit and cursor, ordered by path", async () => {
		const id = await createReady();
		const fs = api.state.fs(id);
		for (const p of [
			"d/a.txt",
			"d/sub/b.txt",
			"d/sub/deep/c.txt",
			"d/.hidden",
			"top.txt",
		]) {
			await fs.write(`/home/user/${p}`, p);
		}
		const names = async (q: string) =>
			(await call("GET", `${sbPath(id)}/files/list?${q}`)).json.data.map(
				(e: Json) => e.path.replace("/home/user/", ""),
			);
		expect(await names("path=d")).toEqual(["d/.hidden", "d/a.txt", "d/sub"]);
		expect(await names("path=d&includeHidden=false")).toEqual([
			"d/a.txt",
			"d/sub",
		]);
		expect(await names("path=d&depth=2")).toEqual([
			"d/.hidden",
			"d/a.txt",
			"d/sub",
			"d/sub/b.txt",
			"d/sub/deep",
		]);
		expect(await names("path=d&depth=3&includeHidden=false")).toContain(
			"d/sub/deep/c.txt",
		);
		const p1 = await call(
			"GET",
			`${sbPath(id)}/files/list?path=d&depth=3&limit=2`,
		);
		expect(p1.json.data).toHaveLength(2);
		const p2 = await call(
			"GET",
			`${sbPath(id)}/files/list?path=d&depth=3&limit=2&cursor=${p1.json.nextCursor}`,
		);
		expect(p2.json.data[0].path > p1.json.data[1].path).toBe(true);
		expect(
			(await call("GET", `${sbPath(id)}/files/list?path=top.txt`)).json.error
				.code,
		).toBe("not_directory");
		expect(
			(await call("GET", `${sbPath(id)}/files/list?path=nope`)).json.error.code,
		).toBe("path_not_found");
		expect(
			(await call("GET", `${sbPath(id)}/files/list?path=d&limit=500`)).status,
		).toBe(400);
		expect(api.contractErrors.filter((e) => !e.includes("limit"))).toEqual([]);
	});

	it("deletes files and directories (recursive only when asked); a missing path is existed=false", async () => {
		const id = await createReady();
		await api.state.fs(id).write("/home/user/dir/f.txt", "x");
		const del = (q: string) => call("DELETE", `${sbPath(id)}/files?${q}`);
		const notEmpty = await del("path=dir");
		expect(notEmpty.status).toBe(409);
		expect(notEmpty.json.error).toMatchObject({
			code: "invalid_state",
			details: { reason: "not_empty" },
		});
		expect((await del("path=dir&recursive=true")).json).toEqual({
			existed: true,
		});
		expect((await del("path=dir&recursive=true")).json).toEqual({
			existed: false,
		});
		expect(
			(await call("GET", `${sbPath(id)}/files/stat?path=dir`)).status,
		).toBe(404);
		expect(api.contractErrors).toEqual([]);
	});

	it("resolves relative paths from the home of the given user", async () => {
		const id = await createReady();
		await call("PUT", `${sbPath(id)}/files/content?path=r.txt&user=root`, {
			raw: "root",
		});
		expect((await api.state.fs(id).stat("/root/r.txt"))?.sizeBytes).toBe(4);
		expect(api.contractErrors).toEqual([]);
	});

	it("answers sandbox_not_ready for files of a stopped sandbox", async () => {
		const id = await createReady();
		await call("POST", `${sbPath(id)}/stop`);
		await call("GET", `${sbPath(id)}?waitFor=stopped&waitSeconds=5`);
		const r = await call("GET", `${sbPath(id)}/files/stat?path=/`);
		expect(r.status).toBe(409);
		expect(r.json.error.code).toBe("sandbox_not_ready");
		expect(api.contractErrors).toEqual([]);
	});
});

describe("ports", () => {
	it("issues a token only for a new token port or a switch to token", async () => {
		const id = await createReady();
		const put = (port: number, body?: unknown) =>
			call(
				"PUT",
				`${sbPath(id)}/ports/${port}`,
				body === undefined ? {} : { body },
			);
		const first = await put(3000);
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({
			access: "token",
			hostRewrite: "preserve",
			appProtocol: "http1",
			blocked: false,
		});
		expect(first.json.token).toMatch(/^sbxp_/);
		expect(first.json.urlWithToken).toBe(
			`${first.json.url}/?_token=${first.json.token}`,
		);
		const same = await put(3000, { access: "token" });
		expect(same.status).toBe(200);
		expect(same.json.token).toBeUndefined();
		const sso = await put(3000, { access: "sso" });
		expect(sso.json.access).toBe("sso");
		expect(sso.json.token).toBeUndefined();
		const back = await put(3000, { access: "token" });
		expect(back.json.token).toMatch(/^sbxp_/);
		expect(back.json.token).not.toBe(first.json.token);
		const fresh = await put(4000, { access: "public" });
		expect(fresh.status).toBe(201);
		expect(fresh.json.token).toBeUndefined();
		expect(api.contractErrors).toEqual([]);
	});

	it("rotates a token only for a hosted token port", async () => {
		const id = await createReady();
		const a = await call("PUT", `${sbPath(id)}/ports/3000`, {});
		const rot = await call("POST", `${sbPath(id)}/ports/3000/rotate-token`);
		expect(rot.status).toBe(200);
		expect(rot.json.token).not.toBe(a.json.token);
		expect(rot.json.urlWithToken).toContain(rot.json.token);
		expect(
			(await call("POST", `${sbPath(id)}/ports/9999/rotate-token`)).status,
		).toBe(404);
		await call("PUT", `${sbPath(id)}/ports/5000`, { body: { access: "sso" } });
		expect(
			(await call("POST", `${sbPath(id)}/ports/5000/rotate-token`)).status,
		).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("lists hosted and listening ports, unhosts idempotently, and checks the port", async () => {
		const id = await createReady();
		api.state.listening.set(id, [
			{ port: 3000, addresses: ["127.0.0.1"], process: "node", user: "user" },
		]);
		await call("PUT", `${sbPath(id)}/ports/3000`, { body: { access: "sso" } });
		const l = await call("GET", `${sbPath(id)}/ports`);
		expect(l.json.hosted).toHaveLength(1);
		expect(l.json.hosted[0]).toMatchObject({
			port: 3000,
			label: expect.stringContaining("-3000"),
			access: "sso",
		});
		expect(l.json.listening).toEqual([
			{ port: 3000, addresses: ["127.0.0.1"], process: "node", user: "user" },
		]);
		expect((await call("DELETE", `${sbPath(id)}/ports/3000`)).status).toBe(204);
		expect((await call("DELETE", `${sbPath(id)}/ports/3000`)).status).toBe(204);
		expect((await call("GET", `${sbPath(id)}/ports`)).json.hosted).toEqual([]);
		expect(
			(await call("PUT", `${sbPath(id)}/ports/22`, {})).json.error.code,
		).toBe("validation");
		expect((await call("PUT", `${sbPath(id)}/ports/70000`, {})).status).toBe(
			400,
		);
		api.state.publicPortsDisabled = true;
		const pub = await call("PUT", `${sbPath(id)}/ports/80`, {
			body: { access: "public" },
		});
		expect(pub.status).toBe(403);
		expect(pub.json.error.details.reason).toBe("public_disabled");
		expect(api.contractErrors.filter((e) => !e.includes("<= 65535"))).toEqual(
			[],
		);
	});

	it("allows hosting on a stopped sandbox", async () => {
		const id = await createReady();
		await call("POST", `${sbPath(id)}/stop`);
		await call("GET", `${sbPath(id)}?waitFor=stopped&waitSeconds=5`);
		expect((await call("PUT", `${sbPath(id)}/ports/3000`, {})).status).toBe(
			201,
		);
		expect(
			(await call("GET", `${sbPath(id)}/ports`)).json.listeningObservedAt,
		).toBeNull();
		expect(api.contractErrors).toEqual([]);
	});
});

describe("snapshots", () => {
	it("saves with an operation, replays by key, lists, gets and creates from it", async () => {
		const id = await createReady();
		await call("PUT", `${sbPath(id)}/files/content?path=keep.txt`, {
			raw: "kept",
		});
		const h = { "Idempotency-Key": "snap-1" };
		const first = await call("POST", "/v1/snapshots", {
			body: { sandbox: id, name: "base" },
			headers: h,
		});
		expect(first.status).toBe(202);
		expect(first.json.snapshot).toMatchObject({
			name: "base",
			state: "creating",
			sourceSandboxId: id,
		});
		expect(first.json.operation).toMatchObject({
			kind: "save_snapshot",
			sandboxId: id,
		});
		const replay = await call("POST", "/v1/snapshots", {
			body: { sandbox: id, name: "base" },
			headers: h,
		});
		expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
		expect(replay.json.snapshot.id).toBe(first.json.snapshot.id);
		expect(
			(
				await call("POST", "/v1/snapshots", {
					body: { sandbox: id, name: "other" },
					headers: h,
				})
			).json.error.code,
		).toBe("idempotency_key_reused");
		const op = await call(
			"GET",
			`/v1/operations/${first.json.operation.id}?waitSeconds=5`,
		);
		expect(op.json.state).toBe("succeeded");
		const snap = await call("GET", "/v1/snapshots/base");
		expect(snap.json).toMatchObject({
			state: "ready",
			consistency: "quiesced",
		});
		expect((await call("GET", "/v1/snapshots")).json.data).toHaveLength(1);
		const from = await call("POST", "/v1/sandboxes", {
			body: { from: { snapshot: "base" } },
		});
		expect(from.json.sandbox.origin).toMatchObject({
			kind: "snapshot",
			snapshot: "base",
			snapshotId: snap.json.id,
		});
		const copy = from.json.sandbox.id as string;
		await call("GET", `${sbPath(copy)}?waitFor=ready&waitSeconds=5`);
		expect(
			new TextDecoder().decode(
				(await call("GET", `${sbPath(copy)}/files/content?path=keep.txt`))
					.bytes,
			),
		).toBe("kept");
		expect(api.contractErrors).toEqual([]);
	});

	it("replaces a snapshot of the same name once the new one is ready", async () => {
		const id = await createReady();
		const a = await call("POST", "/v1/snapshots", {
			body: { sandbox: id, name: "n" },
		});
		await call("GET", `/v1/operations/${a.json.operation.id}?waitSeconds=5`);
		const b = await call("POST", "/v1/snapshots", {
			body: { sandbox: id, name: "n" },
		});
		await call("GET", `/v1/operations/${b.json.operation.id}?waitSeconds=5`);
		const list = await call("GET", "/v1/snapshots");
		expect(list.json.data.map((s: Json) => s.id)).toEqual([b.json.snapshot.id]);
		expect(api.contractErrors).toEqual([]);
	});

	it("rejects a bad name and a missing sandbox, and honours the snapshot quota", async () => {
		const id = await createReady();
		expect(
			(
				await call("POST", "/v1/snapshots", {
					body: { sandbox: id, name: "Bad Name" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call("POST", "/v1/snapshots", {
					body: { sandbox: "sb_missing", name: "ok" },
				})
			).json.error.code,
		).toBe("not_found");
		await api.close();
		api = await startFakeApi({
			readyAfterMs: 10,
			quota: { maxSavedSnapshots: 1 },
		});
		const sb = await createReady();
		const one = await call("POST", "/v1/snapshots", {
			body: { sandbox: sb, name: "one" },
		});
		await call("GET", `/v1/operations/${one.json.operation.id}?waitSeconds=5`);
		const over = await call("POST", "/v1/snapshots", {
			body: { sandbox: sb, name: "two" },
		});
		expect(over.status).toBe(403);
		expect(over.json.error.code).toBe("quota_exceeded");
	});

	it("deletes only with Sbx-Confirm-Delete (id or name), 404 snapshot_not_found otherwise", async () => {
		const id = await createReady();
		const s = await call("POST", "/v1/snapshots", {
			body: { sandbox: id, name: "gone" },
		});
		expect(
			(
				await call("DELETE", "/v1/snapshots/gone", {
					headers: { "Sbx-Confirm-Delete": "gone" },
				})
			).json.error.code,
		).toBe("invalid_state");
		await call("GET", `/v1/operations/${s.json.operation.id}?waitSeconds=5`);
		const none = await call("DELETE", "/v1/snapshots/gone");
		expect(none.status).toBe(428);
		expect(none.json.error.details.reason).toBe("missing");
		expect(
			(
				await call("DELETE", "/v1/snapshots/gone", {
					headers: { "Sbx-Confirm-Delete": "other" },
				})
			).json.error.details.reason,
		).toBe("mismatch");
		expect((await call("GET", "/v1/snapshots")).json.data).toHaveLength(1);
		expect(
			(
				await call("DELETE", "/v1/snapshots/gone", {
					headers: { "Sbx-Confirm-Delete": s.json.snapshot.id },
				})
			).status,
		).toBe(204);
		const missing = await call("DELETE", "/v1/snapshots/gone", {
			headers: { "Sbx-Confirm-Delete": "gone" },
		});
		expect(missing.status).toBe(404);
		expect(missing.json.error.code).toBe("snapshot_not_found");
		expect((await call("GET", "/v1/snapshots/gone")).status).toBe(404);
		expect(api.contractErrors).toEqual([]);
	});
});

describe("desktop", () => {
	async function desktop() {
		return createReady({ template: "linux-desktop" });
	}

	it("scales screenshots like S10 §12.1 (fit, never upscale, Math.round)", () => {
		expect(scaleToFit(1920, 1080, 1280, 800)).toEqual({
			width: 1280,
			height: 720,
		});
		expect(scaleToFit(1280, 800, 1280, 800)).toEqual({
			width: 1280,
			height: 800,
		});
		expect(scaleToFit(3840, 2160, 1280, 800)).toEqual({
			width: 1280,
			height: 720,
		});
		expect(scaleToFit(1024, 768, 1280, 800)).toEqual({
			width: 1024,
			height: 768,
		});
		expect(scaleToFit(2560, 1600, 1280, 800)).toEqual({
			width: 1280,
			height: 800,
		});
		expect(scaleToFit(1920, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(scaleToFit(100, 33, 50)).toEqual({ width: 50, height: 17 });
	});

	it("returns real PNG and JPEG bytes of the scaled size with the Sbx headers", async () => {
		const id = await desktop();
		const png = await call(
			"GET",
			`${sbPath(id)}/desktop/screenshot?maxWidth=1280&maxHeight=800`,
		);
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect([...png.bytes.subarray(0, 8)]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const view = new DataView(png.bytes.buffer, png.bytes.byteOffset);
		expect([view.getUint32(16), view.getUint32(20)]).toEqual([1280, 720]);
		expect(
			Object.fromEntries(
				[
					"Screen-Width",
					"Screen-Height",
					"Image-Width",
					"Image-Height",
					"Cursor-X",
					"Cursor-Y",
				].map((h) => [h, png.headers.get(`Sbx-${h}`)]),
			),
		).toEqual({
			"Screen-Width": "1920",
			"Screen-Height": "1080",
			"Image-Width": "1280",
			"Image-Height": "720",
			"Cursor-X": "960",
			"Cursor-Y": "540",
		});
		expect(png.headers.get("Cache-Control")).toBe("no-store");
		const jpeg = await call(
			"GET",
			`${sbPath(id)}/desktop/screenshot?format=jpeg&quality=85&maxWidth=640`,
		);
		expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
		expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
		expect([...jpeg.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
		// SOF0: height then width
		const sof = jpeg.bytes.indexOf(0xc0, 2);
		expect([
			(jpeg.bytes[sof + 4] ?? 0) * 256 + (jpeg.bytes[sof + 5] ?? 0),
			(jpeg.bytes[sof + 6] ?? 0) * 256 + (jpeg.bytes[sof + 7] ?? 0),
		]).toEqual([360, 640]);
		expect(jpeg.headers.get("Sbx-Image-Width")).toBe("640");
		expect(api.state.desktop.screenshots).toHaveLength(2);
		expect(api.contractErrors).toEqual([]);
	});

	it("crops a region before scaling and refuses a region outside the screen", async () => {
		const id = await desktop();
		const r = await call(
			"GET",
			`${sbPath(id)}/desktop/screenshot?x=100&y=100&width=800&height=400&maxWidth=400`,
		);
		expect(r.headers.get("Sbx-Image-Width")).toBe("400");
		expect(r.headers.get("Sbx-Image-Height")).toBe("200");
		expect(r.headers.get("Sbx-Screen-Width")).toBe("1920");
		const out = await call(
			"GET",
			`${sbPath(id)}/desktop/screenshot?x=1900&y=0&width=100&height=100`,
		);
		expect(out.status).toBe(400);
		expect(out.json.error.code).toBe("invalid_action");
		expect(
			(await call("GET", `${sbPath(id)}/desktop/screenshot?x=1`)).status,
		).toBe(400);
		expect(api.contractErrors).toEqual([]);
	});

	it("uses the screen of the sandbox from the state (default 1920x1080)", async () => {
		const id = await desktop();
		api.state.desktop.screens.set(id, { width: 1280, height: 800 });
		const st = await call("GET", `${sbPath(id)}/desktop`);
		expect(st.json).toMatchObject({
			state: "ready",
			screen: { width: 1280, height: 800 },
			cursor: { x: 640, y: 400 },
			streamer: { running: true },
		});
		expect(st.json.url).toContain("-desktop.");
		const sb = await call("GET", sbPath(id));
		expect(sb.json.endpoints.desktop).toBe(st.json.url);
		expect(api.contractErrors).toEqual([]);
	});

	it("records actions with the coordinate space, moves the cursor and returns a screenshot", async () => {
		const id = await desktop();
		const body = {
			actions: [
				{
					type: "click",
					x: 640,
					y: 360,
					button: "left",
					count: 2,
					modifiers: ["ctrl"],
				},
				{ type: "type", text: "héllo", delayMs: 5 },
				{ type: "key", keys: ["ctrl", "shift", "t"] },
				{ type: "scroll", x: 10, y: 10, dy: 3, dx: 0 },
				{
					type: "drag",
					path: [
						{ x: 0, y: 0 },
						{ x: 100, y: 100 },
					],
				},
				{ type: "wait", ms: 500 },
			],
			coordinateSpace: { width: 1280, height: 720 },
			screenshot: {
				format: "jpeg",
				quality: 85,
				maxWidth: 1280,
				maxHeight: 800,
			},
		};
		const r = await call("POST", `${sbPath(id)}/desktop/actions`, { body });
		expect(r.status).toBe(200);
		expect(r.json.completed).toBe(6);
		expect(r.json.screen).toEqual({ width: 1920, height: 1080 });
		expect(r.json.cursor).toEqual({ x: 150, y: 150 });
		expect(r.json.screenshot).toMatchObject({
			contentType: "image/jpeg",
			width: 1280,
			height: 720,
		});
		expect([
			...Buffer.from(r.json.screenshot.data, "base64").subarray(0, 2),
		]).toEqual([0xff, 0xd8]);
		expect(api.state.desktop.actions).toHaveLength(1);
		expect(api.state.desktop.actions[0]).toMatchObject({
			sandboxId: id,
			coordinateSpace: { width: 1280, height: 720 },
			screenshot: body.screenshot,
		});
		expect(api.state.desktop.actions[0]?.actions[0]).toMatchObject({
			type: "click",
			x: 640,
			y: 360,
		});
		expect((await call("GET", `${sbPath(id)}/desktop`)).json.cursor).toEqual({
			x: 150,
			y: 150,
		});
		expect(api.contractErrors).toEqual([]);
	});

	it("validates the whole action list before running any action", async () => {
		const id = await desktop();
		const post = (actions: unknown[], coordinateSpace?: unknown) =>
			call("POST", `${sbPath(id)}/desktop/actions`, {
				body: { actions, ...(coordinateSpace ? { coordinateSpace } : {}) },
			});
		const outside = await post(
			[
				{ type: "move", x: 10, y: 10 },
				{ type: "click", x: 1280, y: 5 },
			],
			{ width: 1280, height: 720 },
		);
		expect(outside.status).toBe(400);
		expect(outside.json.error).toMatchObject({
			code: "invalid_action",
			details: { index: 1 },
		});
		expect(api.state.desktop.actions).toEqual([]);
		const key = await post([{ type: "key", keys: ["hyper"] }]);
		expect(key.json.error).toMatchObject({
			code: "invalid_action",
			details: { index: 0 },
		});
		expect(
			(await post([{ type: "type", text: "x".repeat(9000), delayMs: 100 }]))
				.json.error.code,
		).toBe("invalid_action");
		expect((await post([{ type: "key", keys: ["ctrl", "f5"] }])).status).toBe(
			200,
		);
		expect((await post([{ type: "bogus" }])).status).toBe(400);
		expect((await post([])).status).toBe(400);
		expect(api.contractErrors.length).toBeGreaterThan(0);
		expect(
			api.contractErrors.every((e) => e.includes("/desktop/actions")),
		).toBe(true);
	});

	it("issues a one-time link, and reads and writes the clipboard", async () => {
		const id = await desktop();
		const link = await call("POST", `${sbPath(id)}/desktop/links`, {
			body: { fps: 60 },
		});
		expect(link.status).toBe(201);
		expect(link.json.url).toContain("_ticket=");
		expect(Date.parse(link.json.expiresAt)).toBeGreaterThan(Date.now());
		expect(api.state.desktop.links).toHaveLength(1);
		expect((await call("POST", `${sbPath(id)}/desktop/links`)).status).toBe(
			201,
		);
		expect((await call("GET", `${sbPath(id)}/desktop/clipboard`)).json).toEqual(
			{ text: "", hasText: false },
		);
		expect(
			(
				await call("PUT", `${sbPath(id)}/desktop/clipboard`, {
					body: { text: "paste me" },
				})
			).status,
		).toBe(204);
		expect((await call("GET", `${sbPath(id)}/desktop/clipboard`)).json).toEqual(
			{ text: "paste me", hasText: true },
		);
		expect(api.contractErrors).toEqual([]);
	});

	it("answers 422 desktop_unsupported for a template without the capability", async () => {
		const id = await createReady({ template: "linux" });
		for (const [m, p, body] of [
			["GET", "/desktop", undefined],
			["GET", "/desktop/screenshot", undefined],
			["POST", "/desktop/actions", { actions: [{ type: "move", x: 1, y: 1 }] }],
			["GET", "/desktop/clipboard", undefined],
		] as const) {
			const r = await call(m, `${sbPath(id)}${p}`, body ? { body } : {});
			expect(r.status, p).toBe(422);
			expect(r.json.error).toMatchObject({
				code: "desktop_unsupported",
				retryable: false,
			});
		}
		expect(api.contractErrors).toEqual([]);
	});

	it("gates desktop routes by scope and scripted faults (desktop_busy)", async () => {
		const id = await desktop();
		const ro = await call("POST", `${sbPath(id)}/desktop/actions`, {
			token: FAKE_TOKENS.readOnly,
			body: { actions: [{ type: "wait", ms: 1 }] },
		});
		expect(ro.json.error.details.requiredScope).toBe("desktop");
		expect(
			(
				await call("GET", `${sbPath(id)}/desktop`, {
					token: FAKE_TOKENS.readOnly,
				})
			).status,
		).toBe(200);
		api.script.failNext = {
			path: /POST .*\/desktop\/actions$/,
			status: 409,
			code: "desktop_busy",
			retryable: true,
		};
		const busy = await call("POST", `${sbPath(id)}/desktop/actions`, {
			body: { actions: [{ type: "wait", ms: 1 }] },
		});
		expect(busy.json.error).toMatchObject({
			code: "desktop_busy",
			retryable: true,
		});
		const stopped = await createReady({ template: "linux-desktop" });
		await call("POST", `${sbPath(stopped)}/stop`);
		await call("GET", `${sbPath(stopped)}?waitFor=stopped&waitSeconds=5`);
		expect(
			(await call("GET", `${sbPath(stopped)}/desktop`)).json.error.code,
		).toBe("sandbox_not_ready");
		expect(api.contractErrors).toEqual([]);
	});
});
