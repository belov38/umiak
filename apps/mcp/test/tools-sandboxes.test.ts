// Catalog and sandbox lifecycle tools (S11 8.1, 8.2) against the fake API.

import { Sbx } from "@sbx/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/context.ts";
import { Deadline, RESPONSE_MARGIN_MS } from "../src/deadline.ts";
import { ToolError } from "../src/errors.ts";
import { IDEMPOTENCY_KEY_RE } from "../src/idempotency.ts";
import { createLogger } from "../src/log.ts";
import { publishedJsonSchemaOf, selectTools } from "../src/registry.ts";
import { lintToolName, lintToolSchema } from "../src/schema-rules.ts";
import {
	CATALOG_TOOLS,
	SANDBOX_TOOLS,
	sandboxView,
	waitSandbox,
} from "../src/tools/index.ts";
import { waitHint } from "../src/tools/sandbox-view.ts";
import { sandboxCreate } from "../src/tools/sandboxes.ts";
import { FAKE_TOKENS } from "./fake-api/index.ts";
import { type Harness, startHarness } from "./helpers/harness.ts";

let h: Harness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function start(o: Parameters<typeof startHarness>[0] = {}) {
	h = await startHarness(o);
	return h;
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What the model may see of a sandbox (spec 8.2). */
const VIEW_KEYS = [
	"id",
	"slug",
	"name",
	"state",
	"health",
	"activity",
	"template",
	"size",
	"labels",
	"deadline_at",
	"idle_timeout_seconds",
	"active_operation",
	"error",
	"endpoints",
	"created_at",
	"operation",
	"source_operation",
	"operation_id",
	"replayed",
	"idempotency_key",
];

/** The tools of 8.1-8.2; later toolsets have their own tests. */
const TOOLS = [...CATALOG_TOOLS, ...SANDBOX_TOOLS];

describe("tool list", () => {
	it("has the 11 tools of 8.1-8.2 in spec order with the annotations of the tables", () => {
		expect(TOOLS.map((t) => t.name)).toEqual([
			"limits_get",
			"templates_list",
			"sandbox_create",
			"sandbox_list",
			"sandbox_get",
			"sandbox_update",
			"sandbox_stop",
			"sandbox_resume",
			"sandbox_fork",
			"sandbox_recover",
			"sandbox_delete",
		]);
		// R D I O of the spec tables.
		const table: Record<string, [boolean, boolean, boolean, boolean]> = {
			limits_get: [true, false, true, false],
			templates_list: [true, false, true, false],
			sandbox_create: [false, false, false, false],
			sandbox_list: [true, false, true, false],
			sandbox_get: [true, false, true, false],
			sandbox_update: [false, false, true, false],
			sandbox_stop: [false, false, true, false],
			sandbox_resume: [false, false, true, false],
			sandbox_fork: [false, false, false, false],
			sandbox_recover: [false, false, true, false],
			sandbox_delete: [false, true, true, false],
		};
		for (const t of TOOLS) {
			const a = t.annotations;
			expect(
				[a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint],
				t.name,
			).toEqual(table[t.name]);
			expect(t.toolset).toBe("core");
		}
	});

	it("scopes are exactly the table", () => {
		const scopes = Object.fromEntries(
			TOOLS.map((t) => [t.name, [...t.scopes]]),
		);
		expect(scopes).toEqual({
			limits_get: [],
			templates_list: [],
			sandbox_create: ["sandboxes:write"],
			sandbox_list: ["sandboxes:read"],
			sandbox_get: ["sandboxes:read"],
			sandbox_update: ["sandboxes:write"],
			sandbox_stop: ["sandboxes:write"],
			sandbox_resume: ["sandboxes:write"],
			sandbox_fork: ["sandboxes:write"],
			sandbox_recover: ["sandboxes:write"],
			sandbox_delete: ["sandboxes:delete"],
		});
	});

	it("schemas pass the 7.2 linter; create, resume and fork take no secrets", () => {
		for (const t of TOOLS) {
			expect(lintToolName(t.name)).toEqual([]);
			const schema = publishedJsonSchemaOf(t, false);
			expect(lintToolSchema(t.name, schema)).toEqual([]);
		}
		for (const name of ["sandbox_create", "sandbox_resume", "sandbox_fork"]) {
			const t = TOOLS.find((d) => d.name === name);
			const props = Object.keys(
				(publishedJsonSchemaOf(t as never, false).properties ?? {}) as object,
			);
			expect(props).not.toContain("secrets");
			expect(props).not.toContain("secret_files");
			expect(props).not.toContain("fail_fast");
		}
	});

	it("env says non-secret values only, every field has a description", () => {
		const props = (name: string) => {
			const t = TOOLS.find((d) => d.name === name);
			return publishedJsonSchemaOf(t as never, false).properties as Record<
				string,
				{ description?: string }
			>;
		};
		for (const name of ["sandbox_create", "sandbox_resume", "sandbox_fork"]) {
			expect(props(name).env?.description).toMatch(/non-secret values only/i);
		}
	});

	it("descriptions stay short", () => {
		const total = TOOLS.reduce((n, t) => n + t.description.length, 0);
		for (const t of TOOLS) expect(t.description.length).toBeLessThan(900);
		expect(total / TOOLS.length).toBeLessThan(700);
	});

	it("the published list stays within its share of the 40 000 character budget", async () => {
		const { conn } = await start({ server: { tools: TOOLS } });
		const listed = await conn.client.listTools();
		// 11 of the 38 tools; Task 13 checks the whole list against 40 000.
		expect(JSON.stringify(listed).length).toBeLessThanOrEqual(
			Math.floor((11 / 38) * 40_000),
		);
		expect(JSON.stringify(listed)).not.toContain("9007199254740991");
	});

	it("pinned mode hides create, list, fork and delete", () => {
		const names = selectTools({
			tools: TOOLS,
			pinnedSandbox: "sb_1",
		}).map((t) => t.name);
		expect(names).toEqual([
			"limits_get",
			"templates_list",
			"sandbox_get",
			"sandbox_update",
			"sandbox_stop",
			"sandbox_resume",
			"sandbox_recover",
		]);
	});

	it("a team key sees the tools its scopes allow", () => {
		const names = selectTools({
			tools: TOOLS,
			principal: { kind: "team_key", scopes: ["sandboxes:read"] },
		}).map((t) => t.name);
		expect(names).toEqual([
			"limits_get",
			"templates_list",
			"sandbox_list",
			"sandbox_get",
		]);
	});
});

describe("limits_get and templates_list", () => {
	it("limits_get names the team key and shows scopes, quota, usage, sizes", async () => {
		const { call } = await start();
		const r = await call("limits_get");
		expect(r.isError).toBe(false);
		expect(r.json.identity).toBe("team key key_fake_full");
		expect(r.json.user).toBeUndefined();
		expect(r.json.team).toMatchObject({ id: "team_fake" });
		expect(r.json.auth.kind).toBe("team_key");
		expect(r.json.auth.scopes).toContain("sandboxes:write");
		expect(r.json.quota).toEqual({
			max_active_sandboxes: 10,
			max_ram_mb: 32768,
			max_saved_snapshots: 20,
		});
		expect(r.json.usage.active_sandboxes).toBe(0);
		expect(r.json.remaining.active_sandboxes).toBe(10);
		expect(r.json.can_create).toBe(true);
		const linux = r.json.templates.find(
			(t: { slug: string }) => t.slug === "linux",
		);
		expect(linux.default_size).toBe("2gb");
		expect(linux.sizes[0]).toMatchObject({
			slug: "1gb",
			memory_mb: 1024,
			allowed: true,
		});
		expect(r.json.rate_limits.starts_per_minute).toBe(30);
		expect(JSON.stringify(r.json)).not.toContain("warm");
		expect(h?.requests.map((q) => q.path).sort()).toEqual([
			"/v1/limits",
			"/v1/me",
		]);
	});

	it("limits_get names the person for a Keycloak login", async () => {
		const { call } = await start({ token: FAKE_TOKENS.oidc });
		const r = await call("limits_get");
		expect(r.json.identity).toBe("user@example.com");
		expect(r.json.user).toMatchObject({ email: "user@example.com" });
	});

	it("limits_get shows the reason when quota blocks a size", async () => {
		const { call } = await start({ api: { quota: { maxActiveSandboxes: 1 } } });
		await call("sandbox_create", { wait: false });
		const r = await call("limits_get");
		expect(r.json.can_create).toBe(false);
		expect(r.json.templates[0].sizes[0].reason).toBe("quota_active_sandboxes");
	});

	it("templates_list shows capabilities and sizes", async () => {
		const { call } = await start();
		const r = await call("templates_list");
		expect(r.isError).toBe(false);
		const slugs = r.json.templates.map((t: { slug: string }) => t.slug);
		expect(slugs).toEqual(["linux", "linux-desktop", "windows"]);
		expect(r.json.templates[1]).toEqual({
			slug: "linux-desktop",
			name: "Linux desktop",
			os: "linux",
			capabilities: ["exec", "files", "ssh", "desktop"],
			default_size: "4gb",
			allowed_sizes: ["4gb", "8gb"],
			login_user: "user",
		});
		expect(r.json.sizes).toContainEqual({
			slug: "2gb",
			vcpu: 2,
			memory_mb: 2048,
		});
	});

	it("a key without scopes still reads the catalog; a read-only key cannot create", async () => {
		const { call } = await start({ token: FAKE_TOKENS.readOnly });
		expect((await call("templates_list")).isError).toBe(false);
		const r = await call("sandbox_create", {});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: forbidden");
		expect(r.texts[0]).toContain("sandboxes:write");
	});
});

describe("sandbox_create", () => {
	it("adds created-via=mcp, waits for ready and answers with the view of 8.2", async () => {
		const { call, api, to } = await start();
		const r = await call("sandbox_create", {
			template: "linux",
			size: "1gb",
			name: "build box",
			labels: { team: "x" },
			env: { A: "1" },
			ttl_seconds: 3600,
			idle_timeout_seconds: 600,
		});
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("ready");
		expect(r.json.id).toMatch(/^sb_/);
		expect(r.json.labels).toEqual({ "created-via": "mcp", team: "x" });
		expect(r.json.template).toBe("linux");
		expect(r.json.size).toBe("1gb");
		expect(r.json.name).toBe("build box");
		expect(r.json.idle_timeout_seconds).toBe(600);
		expect(r.json.deadline_at).toMatch(/^\d{4}-/);
		expect(r.json.endpoints.port_url_template).toContain("{port}");
		expect(r.json.endpoints.ssh).toMatch(/^ssh /);
		expect(r.json.operation).toMatchObject({
			kind: "create",
			state: "succeeded",
		});
		expect(r.json.operation_id).toBeUndefined();
		expect(r.json.idempotency_key).toMatch(UUID);
		expect(r.json.replayed).toBeUndefined();
		expect(Object.keys(r.json).filter((k) => !VIEW_KEYS.includes(k))).toEqual(
			[],
		);
		const text = r.texts[0] ?? "";
		for (const dropped of [
			"createdBy",
			"templateVersion",
			"created_by",
			"team_id",
			"memory_mb",
		]) {
			expect(text).not.toContain(dropped);
		}
		expect(r.lines).toBe("");
		const post = to("POST", "/v1/sandboxes");
		expect(post).toHaveLength(1);
		expect(post[0]?.body).toEqual({
			template: "linux",
			size: "1gb",
			name: "build box",
			labels: { "created-via": "mcp", team: "x" },
			env: { A: "1" },
			ttlSeconds: 3600,
			idleTimeoutSeconds: 600,
		});
		expect(api.state.sandboxes.size).toBe(1);
	});

	it("keeps a created-via label the model set", async () => {
		const { call, to } = await start();
		await call("sandbox_create", {
			labels: { "created-via": "ci" },
			wait: false,
		});
		expect(to("POST", "/v1/sandboxes")[0]?.body).toMatchObject({
			labels: { "created-via": "ci" },
		});
	});

	it("sends from_snapshot as from.snapshot and environment by name", async () => {
		const { call, to, api } = await start();
		api.state.environments.add("base");
		const r = await call("sandbox_create", {
			from_snapshot: "nope",
			environment: "base",
			wait: false,
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: snapshot_not_found");
		expect(to("POST", "/v1/sandboxes")[0]?.body).toMatchObject({
			from: { snapshot: "nope" },
			environment: "base",
		});
	});

	it("still running after wait_seconds: state creating, operation_id and the hint, within 3 s", async () => {
		const { call } = await start({ api: { readyAfterMs: 60_000 } });
		const t0 = Date.now();
		const r = await call("sandbox_create", { wait_seconds: 2 });
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("creating");
		expect(r.json.operation_id).toMatch(/^op_/);
		expect(r.json.operation).toMatchObject({
			kind: "create",
			state: "running",
		});
		expect(r.lines).toContain(
			"state not final yet: call sandbox_get with wait_for=ready and wait_seconds=50",
		);
		expect(r.json.idempotency_key).toMatch(UUID);
	});

	it("wait=false answers at once with the hint", async () => {
		const { call, to } = await start({ api: { readyAfterMs: 60_000 } });
		const r = await call("sandbox_create", { wait: false });
		expect(r.json.state).toBe("creating");
		expect(r.lines).toContain("wait_for=ready");
		expect(to("GET", `/v1/sandboxes/${r.json.id}`)).toHaveLength(0);
	});

	it("the key of a repeat gives one sandbox and replayed: true", async () => {
		const { call, api } = await start();
		const first = await call("sandbox_create", {
			idempotency_key: "run-7f3a",
			name: "once",
		});
		expect(first.json.idempotency_key).toBe("run-7f3a");
		expect(first.json.replayed).toBeUndefined();
		const again = await call("sandbox_create", {
			idempotency_key: "run-7f3a",
			name: "once",
		});
		expect(again.isError).toBe(false);
		expect(again.json.id).toBe(first.json.id);
		expect(again.json.replayed).toBe(true);
		expect(again.json.idempotency_key).toBe("run-7f3a");
		expect(again.lines).toContain(
			"result of an earlier call with the same idempotency_key",
		);
		expect(api.state.sandboxes.size).toBe(1);
	});

	it("sends the derived key, and the same model key with other arguments is a 409 with a hint", async () => {
		const { call, requests } = await start();
		await call("sandbox_create", { idempotency_key: "k1", name: "a" });
		expect(
			requests.find((q) => q.method === "POST")?.headers.get("Idempotency-Key"),
		).toBe("mcp:sandbox_create:k1");
		const r = await call("sandbox_create", {
			idempotency_key: "k1",
			name: "b",
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: idempotency_key_reused");
		expect(r.texts[0]).toContain("use a new idempotency_key");
	});

	it("a generated key is sent derived and returned as is, so a repeat attaches", async () => {
		const { call, requests, api } = await start();
		const first = await call("sandbox_create", {});
		const key = first.json.idempotency_key as string;
		expect(key).toMatch(UUID);
		expect(
			requests.find((q) => q.method === "POST")?.headers.get("Idempotency-Key"),
		).toBe(`mcp:sandbox_create:${key}`);
		const again = await call("sandbox_create", { idempotency_key: key });
		expect(again.json.id).toBe(first.json.id);
		expect(again.json.replayed).toBe(true);
		expect(api.state.sandboxes.size).toBe(1);
	});

	it("rejects a malformed idempotency_key in the schema", async () => {
		const { call, to } = await start();
		for (const bad of ["", "has space", "x".repeat(129), "a/b"]) {
			const r = await call("sandbox_create", { idempotency_key: bad });
			expect(r.isError).toBe(true);
			expect(r.texts.join("\n")).toContain("idempotency_key");
		}
		expect(to("POST", "/v1/sandboxes")).toHaveLength(0);
		expect(IDEMPOTENCY_KEY_RE.test("ok.key_1-2")).toBe(true);
	});

	it("state error is an error result with sandbox.error", async () => {
		const { call, api } = await start();
		api.script.createFails = { code: "create_failed", message: "no capacity" };
		const r = await call("sandbox_create", {});
		expect(r.isError).toBe(true);
		expect(r.json.state).toBe("error");
		expect(r.json.error).toEqual({
			code: "create_failed",
			message: "no capacity",
		});
		expect(r.json.operation).toMatchObject({ kind: "create", state: "failed" });
		expect(r.lines).toContain("sandbox_recover");
		expect(r.json.idempotency_key).toMatch(UUID);
	});

	it("quota_exceeded comes with the hint to look at limits_get", async () => {
		const { call } = await start({ api: { quota: { maxActiveSandboxes: 0 } } });
		const r = await call("sandbox_create", {});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: quota_exceeded");
		expect(r.texts[0]).toContain("limits_get");
	});

	it("sends progress about every 5 s while waiting", async () => {
		const { call } = await start({ api: { readyAfterMs: 60_000 } });
		const seen: number[] = [];
		const r = await call(
			"sandbox_create",
			{ wait_seconds: 7 },
			{ onprogress: (p) => seen.push(p.progress) },
		);
		expect(r.json.state).toBe("creating");
		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen[0]).toBeGreaterThanOrEqual(4.5);
		expect(seen[0]).toBeLessThanOrEqual(5.5);
		expect([...seen].sort((a, b) => a - b)).toEqual(seen);
	}, 20_000);
});

/** A context with its own short deadline, to test what the 50 s budget does. */
function shortContext(
	sbx: Sbx,
	budgetMs: number,
): { ctx: ToolContext; deadline: Deadline } {
	const deadline = new Deadline(new AbortController().signal, budgetMs);
	const ctx: ToolContext = {
		sbx: () => sbx,
		deadline,
		get call() {
			return {
				signal: deadline.signal,
				retryBudgetMs: Math.max(0, deadline.remainingMs() - RESPONSE_MARGIN_MS),
			};
		},
		sandbox: (ref) => ref,
		pinned: false,
		progress: async () => {},
		cancelledByClient: () => false,
		transport: "stdio",
		log: createLogger({ level: "silent" }),
		userAgent: "test",
	};
	return { ctx, deadline };
}

describe("deadline", () => {
	it("a create that gets no answer is deadline_exceeded with the model key", async () => {
		const hang = new Sbx({
			baseUrl: "http://127.0.0.1:9",
			apiKey: "k",
			env: {},
			fetch: (input, init) =>
				new Promise((_, reject) => {
					const signal = new Request(input, init).signal;
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		const { ctx, deadline } = shortContext(hang, 300);
		const err = await sandboxCreate
			.handler({ idempotency_key: "k-hang", sandbox: "" }, ctx)
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		deadline.dispose();
		expect(err).toBeInstanceOf(ToolError);
		expect(err).toMatchObject({
			code: "deadline_exceeded",
			retryable: true,
			idempotencyKey: "k-hang",
		});
		expect((err as ToolError).hint).toContain("attach to it");
	});

	it("waitSandbox returns the latest data when the time is up and never throws for it", async () => {
		const { sbx, api, call } = await start({ api: { readyAfterMs: 60_000 } });
		const created = await call("sandbox_create", { wait: false });
		const { ctx, deadline } = shortContext(sbx, 5000);
		const t0 = Date.now();
		const data = await waitSandbox(ctx, created.json.id, "ready", 1500);
		deadline.dispose();
		expect(data.state).toBe("creating");
		expect(Date.now() - t0).toBeLessThan(3500);
		expect(api.contractErrors).toEqual([]);
	});

	it("waitSandbox with no time still reads the sandbox once", async () => {
		const { sbx, call, to } = await start({ api: { readyAfterMs: 60_000 } });
		const created = await call("sandbox_create", { wait: false });
		const { ctx, deadline } = shortContext(sbx, 5000);
		const data = await waitSandbox(ctx, created.json.id, "ready", 0);
		deadline.dispose();
		expect(data.id).toBe(created.json.id);
		expect(to("GET", `/v1/sandboxes/${created.json.id}`)).toHaveLength(1);
	});

	it("waitSandbox keeps the data of the action when the deadline cuts the first poll", async () => {
		const { sbx, call, api } = await start({ api: { readyAfterMs: 60_000 } });
		const created = await call("sandbox_create", { wait: false });
		api.script.silent = true;
		const { ctx, deadline } = shortContext(sbx, 600);
		const action = await sbx.raw.GET("/v1/sandboxes/{sandbox}", {
			params: { path: { sandbox: created.json.id } },
		});
		const data = await waitSandbox(
			ctx,
			created.json.id,
			"ready",
			5000,
			action.data,
		);
		deadline.dispose();
		expect(data.state).toBe("creating");
	});
});

describe("sandbox_list", () => {
	it("returns one page with next_cursor and filters", async () => {
		const { call, to } = await start();
		for (let i = 0; i < 3; i++) {
			await call("sandbox_create", {
				name: `box-${i}`,
				labels: { group: i < 2 ? "a" : "b" },
				wait: false,
			});
		}
		const first = await call("sandbox_list", { limit: 2 });
		expect(first.json.count).toBe(2);
		expect(first.json.sandboxes.map((s: { name: string }) => s.name)).toEqual([
			"box-2",
			"box-1",
		]);
		expect(first.json.next_cursor).toEqual(expect.any(String));
		expect(first.lines).toContain("cursor=next_cursor");
		// Nothing but the fields of 8.2, none of them empty.
		for (const s of first.json.sandboxes) {
			expect(Object.keys(s).filter((k) => !VIEW_KEYS.includes(k))).toEqual([]);
			expect(Object.values(s)).not.toContain(null);
		}

		const second = await call("sandbox_list", {
			limit: 2,
			cursor: first.json.next_cursor,
		});
		expect(second.json.sandboxes.map((s: { name: string }) => s.name)).toEqual([
			"box-0",
		]);
		expect(second.json.next_cursor).toBeUndefined();

		const byLabel = await call("sandbox_list", { labels: { group: "a" } });
		expect(byLabel.json.count).toBe(2);
		const both = await call("sandbox_list", {
			labels: { group: "a", "created-via": "mcp" },
			state: "creating,ready",
			template: "linux",
			query: "fake-box-1",
		});
		expect(both.json.sandboxes.map((s: { slug: string }) => s.slug)).toEqual([
			"fake-box-1",
		]);
		expect(to("GET", "/v1/sandboxes")).toHaveLength(4);
	});

	it("says so when nothing matches", async () => {
		const { call } = await start();
		const r = await call("sandbox_list", { labels: { none: "x" } });
		expect(r.isError).toBe(false);
		expect(r.json).toEqual({ count: 0 });
		expect(r.lines).toContain("no sandbox matches");
	});

	it("rejects a limit above 200 in the schema", async () => {
		const { call, to } = await start();
		const r = await call("sandbox_list", { limit: 201 });
		expect(r.isError).toBe(true);
		expect(to("GET", "/v1/sandboxes")).toHaveLength(0);
	});

	it("sends labels as repeated label=value and query as q", async () => {
		const { call, requests } = await start();
		await call("sandbox_list", { labels: { a: "1", b: "x=y" }, query: "my" });
		const q = requests.at(-1)?.query;
		expect(q?.getAll("label")).toEqual(["a=1", "b=x=y"]);
		expect(q?.get("q")).toBe("my");
		expect(q?.get("limit")).toBe("50");
	});
});

describe("sandbox_get", () => {
	it("reads without waiting", async () => {
		const { call, to } = await start({ api: { readyAfterMs: 60_000 } });
		const c = await call("sandbox_create", { wait: false });
		const r = await call("sandbox_get", { sandbox: c.json.id });
		expect(r.json.state).toBe("creating");
		expect(r.json.active_operation).toMatchObject({ kind: "create" });
		expect(r.isError).toBe(false);
		expect(r.lines).toBe("");
		expect(to("GET", `/v1/sandboxes/${c.json.id}`)).toHaveLength(1);
	});

	it("wait_for=ready returns when the sandbox is ready", async () => {
		const { call } = await start({ api: { readyAfterMs: 300 } });
		const c = await call("sandbox_create", { wait: false });
		const r = await call("sandbox_get", {
			sandbox: c.json.id,
			wait_for: "ready",
			wait_seconds: 10,
		});
		expect(r.json.state).toBe("ready");
		expect(r.lines).toBe("");
	});

	it("a slug works as the sandbox", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", { slug: "my-box" });
		const r = await call("sandbox_get", { sandbox: "my-box" });
		expect(r.json.id).toBe(c.json.id);
	});

	it("wait_for times out with the hint and the operation id", async () => {
		const { call } = await start({ api: { readyAfterMs: 60_000 } });
		const c = await call("sandbox_create", { wait: false });
		const r = await call("sandbox_get", {
			sandbox: c.json.id,
			wait_for: "ready",
			wait_seconds: 1,
		});
		expect(r.json.state).toBe("creating");
		expect(r.json.operation_id).toBe(c.json.operation.id);
		expect(r.lines).toContain("wait_for=ready and wait_seconds=50");
	});

	it("waiting for ready on a stopped sandbox answers at once and points to resume", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", {});
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		const t0 = Date.now();
		const r = await call("sandbox_get", {
			sandbox: c.json.id,
			wait_for: "ready",
			wait_seconds: 20,
		});
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(r.json.state).toBe("stopped");
		expect(r.lines).toContain("sandbox_resume");
	});

	it("a failed sandbox is an error result when waiting, a plain read otherwise", async () => {
		const { call, api } = await start();
		api.script.createFails = { code: "create_failed", message: "boom" };
		const c = await call("sandbox_create", { wait: false });
		const waited = await call("sandbox_get", {
			sandbox: c.json.id,
			wait_for: "ready",
			wait_seconds: 5,
		});
		expect(waited.isError).toBe(true);
		expect(waited.json.error).toEqual({
			code: "create_failed",
			message: "boom",
		});
		const plain = await call("sandbox_get", { sandbox: c.json.id });
		expect(plain.isError).toBe(false);
		expect(plain.json.state).toBe("error");
	});

	it("an unknown sandbox is not_found with a hint", async () => {
		const { call } = await start();
		const r = await call("sandbox_get", { sandbox: "sb_nope" });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: not_found");
		expect(r.texts[0]).toContain("sandbox_list");
	});
});

describe("sandbox_update", () => {
	it("ttl_seconds: 0 sends ttlSeconds: null; other values are sent as they are", async () => {
		const { call, to, api } = await start();
		const c = await call("sandbox_create", { ttl_seconds: 600 });
		expect(c.json.deadline_at).toBeDefined();
		const removed = await call("sandbox_update", {
			sandbox: c.json.id,
			ttl_seconds: 0,
		});
		const patches = to("PATCH", `/v1/sandboxes/${c.json.id}`);
		expect(patches[0]?.body).toEqual({ ttlSeconds: null });
		expect(removed.json.deadline_at).toBeUndefined();
		expect(api.state.sandboxes.get(c.json.id)?.ttlSeconds).toBeNull();

		const set = await call("sandbox_update", {
			sandbox: c.json.id,
			ttl_seconds: 900,
			name: "renamed",
			labels: { only: "this" },
			idle_timeout_seconds: 120,
		});
		expect(to("PATCH", `/v1/sandboxes/${c.json.id}`)[1]?.body).toEqual({
			ttlSeconds: 900,
			name: "renamed",
			labels: { only: "this" },
			idleTimeoutSeconds: 120,
		});
		expect(set.json.name).toBe("renamed");
		expect(set.json.labels).toEqual({ only: "this" });
		expect(set.json.idle_timeout_seconds).toBe(120);
		expect(set.json.deadline_at).toMatch(/^\d{4}-/);
	});

	it("asks for at least one field instead of sending an empty patch", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_update", { sandbox: c.json.id });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: validation");
		expect(to("PATCH", `/v1/sandboxes/${c.json.id}`)).toHaveLength(0);
	});

	it("a taken slug is slug_taken", async () => {
		const { call } = await start();
		await call("sandbox_create", { slug: "taken-one" });
		const c = await call("sandbox_create", { slug: "other-one" });
		const r = await call("sandbox_update", {
			sandbox: c.json.id,
			slug: "taken-one",
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("slug_taken");
	});
});

describe("sandbox_stop", () => {
	it("answers at once by default and waits with wait=true", async () => {
		const { call, to } = await start({ api: { readyAfterMs: 200 } });
		const c = await call("sandbox_create", {});
		const readsBefore = to("GET", `/v1/sandboxes/${c.json.id}`).length;
		const quick = await call("sandbox_stop", { sandbox: c.json.id });
		expect(quick.json.state).toBe("stopping");
		expect(quick.json.operation).toMatchObject({
			kind: "stop",
			state: "running",
		});
		expect(quick.json.operation_id).toBe(quick.json.operation.id);
		expect(quick.lines).toContain("wait_for=stopped and wait_seconds=50");
		expect(to("GET", `/v1/sandboxes/${c.json.id}`)).toHaveLength(readsBefore);

		const done = await call("sandbox_stop", {
			sandbox: c.json.id,
			wait: true,
			wait_seconds: 10,
		});
		expect(done.json.state).toBe("stopped");
		expect(done.json.operation).toMatchObject({
			kind: "stop",
			state: "succeeded",
		});
		expect(done.lines).toBe("");
	});

	it("stopping a stopped sandbox is an error of the API, passed on", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", {});
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		const r = await call("sandbox_stop", { sandbox: c.json.id });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: ");
	});
});

describe("sandbox_resume", () => {
	it("env and unset_env become {K: v | null} in the body", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", { env: { B: "old", KEEP: "1" } });
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		const r = await call("sandbox_resume", {
			sandbox: c.json.id,
			env: { A: "1" },
			unset_env: ["B"],
			size: "4gb",
			ttl_seconds: 300,
		});
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("ready");
		expect(r.json.size).toBe("4gb");
		expect(r.json.operation).toMatchObject({
			kind: "resume",
			state: "succeeded",
		});
		expect(to("POST", `/v1/sandboxes/${c.json.id}/resume`)[0]?.body).toEqual({
			env: { A: "1", B: null },
			size: "4gb",
			ttlSeconds: 300,
		});
		expect(h?.api.state.sandboxes.get(c.json.id)?.env).toEqual({
			A: "1",
			KEEP: "1",
		});
	});

	it("resume without arguments sends an empty body", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", {});
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		await call("sandbox_resume", { sandbox: c.json.id, wait: false });
		expect(to("POST", `/v1/sandboxes/${c.json.id}/resume`)[0]?.body).toEqual(
			{},
		);
	});

	it("a key in env and unset_env is refused before the API is called", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", {});
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		const r = await call("sandbox_resume", {
			sandbox: c.json.id,
			env: { A: "1" },
			unset_env: ["A"],
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: validation");
		expect(to("POST", `/v1/sandboxes/${c.json.id}/resume`)).toHaveLength(0);
	});

	it("resuming a ready sandbox says why, with the state", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_resume", { sandbox: c.json.id });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("ready");
	});
});

describe("sandbox_fork", () => {
	it("copies the sandbox, answers with operation and source_operation", async () => {
		const { call, to, api } = await start();
		const src = await call("sandbox_create", {
			env: { A: "1", B: "2" },
			labels: { keep: "me" },
		});
		const r = await call("sandbox_fork", {
			sandbox: src.json.id,
			name: "copy",
			env: { C: "3" },
			unset_env: ["B"],
			size: "4gb",
			ttl_seconds: 120,
			idle_timeout_seconds: 90,
		});
		expect(r.isError).toBe(false);
		expect(r.json.id).not.toBe(src.json.id);
		expect(r.json.state).toBe("ready");
		expect(r.json.name).toBe("copy");
		expect(r.json.size).toBe("4gb");
		expect(r.json.operation).toMatchObject({
			kind: "create",
			state: "succeeded",
		});
		expect(r.json.source_operation).toMatchObject({ kind: "fork" });
		// Both operations are over once the copy is ready (the fake's source
		// `fork` operation ends on the same timer as the create).
		expect(r.json.operation.state).toBe("succeeded");
		expect(r.json.source_operation.state).toBe("succeeded");
		expect(r.json.idempotency_key).toMatch(UUID);
		expect(Object.keys(r.json).filter((k) => !VIEW_KEYS.includes(k))).toEqual(
			[],
		);
		const post = to("POST", `/v1/sandboxes/${src.json.id}/fork`);
		expect(post[0]?.body).toEqual({
			name: "copy",
			env: { C: "3", B: null },
			size: "4gb",
			ttlSeconds: 120,
			idleTimeoutSeconds: 90,
		});
		expect(api.state.sandboxes.get(r.json.id)?.env).toEqual({ A: "1", C: "3" });
	});

	it("a repeat with the same key forks once and is marked replayed", async () => {
		const { call, api, requests } = await start();
		const src = await call("sandbox_create", {});
		const first = await call("sandbox_fork", {
			sandbox: src.json.id,
			idempotency_key: "fork-1",
		});
		const again = await call("sandbox_fork", {
			sandbox: src.json.id,
			idempotency_key: "fork-1",
		});
		expect(again.json.id).toBe(first.json.id);
		expect(again.json.replayed).toBe(true);
		expect(again.json.source_operation).toBeDefined();
		expect(again.lines).toContain("result of an earlier call");
		expect(api.state.sandboxes.size).toBe(2);
		expect(
			requests
				.filter((q) => q.path.endsWith("/fork"))[0]
				?.headers.get("Idempotency-Key"),
		).toBe(`mcp:sandbox_fork:${src.json.id}:fork-1`);
	});

	it("the same model key on another sandbox is not a 409", async () => {
		const { call, api } = await start();
		const a = await call("sandbox_create", {});
		const b = await call("sandbox_create", {});
		const fa = await call("sandbox_fork", {
			sandbox: a.json.id,
			idempotency_key: "same",
		});
		const fb = await call("sandbox_fork", {
			sandbox: b.json.id,
			idempotency_key: "same",
		});
		expect(fa.isError).toBe(false);
		expect(fb.isError).toBe(false);
		expect(fb.json.id).not.toBe(fa.json.id);
		expect(api.state.sandboxes.size).toBe(4);
	});

	it("an id on the first call and the slug on the retry are one fork", async () => {
		const { call, api, requests } = await start();
		const src = await call("sandbox_create", { slug: "fork-src" });
		const first = await call("sandbox_fork", {
			sandbox: src.json.id,
			idempotency_key: "fork-slug",
		});
		const again = await call("sandbox_fork", {
			sandbox: "fork-src",
			idempotency_key: "fork-slug",
		});
		expect(again.isError).toBe(false);
		expect(again.json.id).toBe(first.json.id);
		expect(again.json.replayed).toBe(true);
		expect(api.state.sandboxes.size).toBe(2);
		const keys = requests
			.filter((q) => q.method === "POST" && q.path.endsWith("/fork"))
			.map((q) => q.headers.get("Idempotency-Key"));
		expect(keys).toEqual([
			`mcp:sandbox_fork:${src.json.id}:fork-slug`,
			`mcp:sandbox_fork:${src.json.id}:fork-slug`,
		]);
	});

	it("an id is not looked up; an unknown slug falls through to the API's 404", async () => {
		const { call, to } = await start();
		const src = await call("sandbox_create", {});
		const before = to("GET", `/v1/sandboxes/${src.json.id}`).length;
		await call("sandbox_fork", { sandbox: src.json.id });
		expect(to("GET", `/v1/sandboxes/${src.json.id}`).length).toBe(before);
		const r = await call("sandbox_fork", { sandbox: "no-such-box" });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: not_found");
		expect(to("GET", "/v1/sandboxes/no-such-box")).toHaveLength(1);
		expect(to("POST", "/v1/sandboxes/no-such-box/fork")).toHaveLength(1);
	});

	it("not ready in time: state creating and the hint", async () => {
		const { call, api } = await start();
		const src = await call("sandbox_create", {});
		// The source is ready; the copy starts slowly.
		api.state.readyAfterMs = 60_000;
		const r = await call("sandbox_fork", {
			sandbox: src.json.id,
			wait_seconds: 1,
		});
		expect(r.json.state).toBe("creating");
		expect(r.json.operation_id).toBe(r.json.operation.id);
		expect(r.lines).toContain("wait_for=ready");
		expect(r.json.idempotency_key).toMatch(UUID);
		expect(r.json.source_operation.id).toMatch(/^op_/);
	});
});

describe("sandbox_recover", () => {
	it("reboots a ready sandbox and waits for ready", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_recover", { sandbox: c.json.id });
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("ready");
		expect(r.json.operation).toMatchObject({
			kind: "recover",
			state: "succeeded",
		});
	});

	it("recovers a sandbox in error", async () => {
		const { call, api } = await start();
		api.script.createFails = { code: "create_failed", message: "boom" };
		const c = await call("sandbox_create", {});
		expect(c.isError).toBe(true);
		const r = await call("sandbox_recover", { sandbox: c.json.id });
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("ready");
		expect(r.json.error).toBeUndefined();
	});

	it("recovering a stopped sandbox is an API error", async () => {
		const { call } = await start();
		const c = await call("sandbox_create", {});
		await call("sandbox_stop", { sandbox: c.json.id, wait: true });
		const r = await call("sandbox_recover", { sandbox: c.json.id });
		expect(r.isError).toBe(true);
	});
});

describe("sandbox_delete", () => {
	it("confirm is required by the schema", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_delete", { sandbox: c.json.id });
		expect(r.isError).toBe(true);
		expect(r.texts.join("\n")).toContain("confirm");
		const empty = await call("sandbox_delete", {
			sandbox: c.json.id,
			confirm: "",
		});
		expect(empty.isError).toBe(true);
		expect(to("DELETE", `/v1/sandboxes/${c.json.id}`)).toHaveLength(0);
		expect(h?.api.state.sandboxes.get(c.json.id)?.state).toBe("ready");
	});

	it("a wrong confirm is confirmation_required and the sandbox stays", async () => {
		const { call, api, to } = await start();
		const c = await call("sandbox_create", {});
		const other = await call("sandbox_create", {});
		const r = await call("sandbox_delete", {
			sandbox: c.json.id,
			confirm: other.json.id,
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("error: confirmation_required");
		expect(r.texts[0]).toContain(`confirm="${c.json.id}"`);
		expect(api.state.sandboxes.get(c.json.id)?.state).toBe("ready");
		expect(
			to("DELETE", `/v1/sandboxes/${c.json.id}`)[0]?.headers.get(
				"Sbx-Confirm-Delete",
			),
		).toBe(other.json.id);
	});

	it("a confirm that is not header text is refused by the schema", async () => {
		const { call, to } = await start();
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_delete", {
			sandbox: c.json.id,
			confirm: "sb\u{e9}",
		});
		expect(r.isError).toBe(true);
		expect(to("DELETE", `/v1/sandboxes/${c.json.id}`)).toHaveLength(0);
	});

	it("the right confirm deletes; the id or the slug both work", async () => {
		const { call, api } = await start();
		const a = await call("sandbox_create", { slug: "doomed" });
		const r = await call("sandbox_delete", {
			sandbox: a.json.id,
			confirm: a.json.id,
		});
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("deleting");
		expect(r.json.operation).toMatchObject({ kind: "delete" });
		expect(r.lines).toContain("being deleted");
		await vi.waitFor(() =>
			expect(api.state.sandboxes.get(a.json.id)?.state).toBe("deleted"),
		);
		const b = await call("sandbox_create", { slug: "doomed-too" });
		const bySlug = await call("sandbox_delete", {
			sandbox: b.json.id,
			confirm: "doomed-too",
		});
		expect(bySlug.isError).toBe(false);
	});

	it("deleting a deleted sandbox says it was already gone", async () => {
		const { call, api } = await start({ api: { readyAfterMs: 10 } });
		const a = await call("sandbox_create", {});
		await call("sandbox_delete", { sandbox: a.json.id, confirm: a.json.id });
		await vi.waitFor(() =>
			expect(api.state.sandboxes.get(a.json.id)?.state).toBe("deleted"),
		);
		const r = await call("sandbox_delete", {
			sandbox: a.json.id,
			confirm: a.json.id,
		});
		expect(r.isError).toBe(false);
		expect(r.json.state).toBe("deleted");
		expect(r.lines).toContain("already deleted");
	});

	it("a key without sandboxes:delete is forbidden with the scope named", async () => {
		const { call } = await start({
			api: {
				tokens: {
					nodelete: {
						kind: "team_key",
						scopes: ["sandboxes:read", "sandboxes:write"],
						teamId: "team_fake",
						keyId: "key_nodelete",
					},
				},
			},
			token: "nodelete",
		});
		const c = await call("sandbox_create", {});
		const r = await call("sandbox_delete", {
			sandbox: c.json.id,
			confirm: c.json.id,
		});
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toContain("sandboxes:delete");
	});
});

describe("pinned mode", () => {
	it("tools take the pinned sandbox and have no sandbox argument", async () => {
		const { call, conn, sbx } = await start({
			server: { pinnedSandbox: "pinned-box" },
		});
		const { data } = await sbx.raw.POST("/v1/sandboxes", {
			body: { slug: "pinned-box" },
		});
		const listed = await conn.client.listTools();
		const names = listed.tools.map((t) => t.name);
		expect(names).not.toContain("sandbox_create");
		expect(names).not.toContain("sandbox_list");
		expect(names).not.toContain("sandbox_fork");
		expect(names).not.toContain("sandbox_delete");
		const get = listed.tools.find((t) => t.name === "sandbox_get");
		expect(get?.inputSchema.properties).not.toHaveProperty("sandbox");
		const r = await call("sandbox_get", {});
		expect(r.json.id).toBe(data.sandbox.id);
		const stop = await call("sandbox_stop", { wait: true, wait_seconds: 5 });
		expect(stop.json.state).toBe("stopped");
	});
});

describe("sandboxView", () => {
	it("keeps the fields of 8.2 and nothing else", async () => {
		const { sbx, call } = await start();
		const c = await call("sandbox_create", { labels: { a: "b" } });
		const { data } = await sbx.raw.GET("/v1/sandboxes/{sandbox}", {
			params: { path: { sandbox: c.json.id } },
		});
		const view = sandboxView(data);
		expect(Object.keys(view)).toEqual([
			"id",
			"slug",
			"name",
			"state",
			"health",
			"activity",
			"template",
			"size",
			"labels",
			"deadline_at",
			"idle_timeout_seconds",
			"active_operation",
			"error",
			"endpoints",
			"created_at",
		]);
		expect(view.labels).toEqual({ "created-via": "mcp", a: "b" });
	});
});

describe("waitHint", () => {
	it("pinned: state error names sandbox_recover, not the hidden sandbox_delete", () => {
		expect(waitHint("error", "ready")).toContain("sandbox_delete");
		const pinned = waitHint("error", "ready", true) ?? "";
		expect(pinned).toContain("sandbox_recover");
		expect(pinned).not.toContain("sandbox_delete");
	});
});
