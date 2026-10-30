// Secret leak matrix (S7 §2 anti-goal 3, §8.3, global constraints): marker
// values in env, secrets and secret files (raw and base64), API key
// secrets, port tokens, bearer tokens (team keys and a Keycloak JWT) and
// port SSO codes go through create, fork, resume, PUT/PATCH /env,
// environments, commands, api-keys, ports and the SSO exchange, with
// Idempotency-Keys and real pg-boss jobs. Then:
// - the captured logs of the api and of the core service, and /metrics,
//   contain none of them;
// - runtime.operations.request/progress, runtime.idempotency_keys,
//   runtime.sandbox_events and pgboss.job.data contain none of them;
// - no other table holds a secret value in clear text;
// - no response (headers and body) carries a secret or secret file value, a bearer, or a key
//   secret or port token other than in the one answer that issues it; env
//   values only in the answers that show env (GET/PUT/PATCH /env and
//   environments).
import { randomUUID } from "node:crypto";
import { decodeUuid, generateApiKeySecret } from "@sbx/auth";
import { ensureQueues, PgBossJobSender, SandboxServiceImpl } from "@sbx/core";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDeps, ServiceTokens } from "../src/index.ts";
import {
	captureLogs,
	startTestOidcServer,
	type TestOidcServer,
	testSettings,
} from "../src/testing/index.ts";
import {
	createHarness,
	type Harness,
	type HarnessResponse,
} from "./helpers/harness.ts";
import { type Any, ok, type Person, personOf } from "./helpers/security.ts";
import { testSshCa } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const RUN = randomUUID().replaceAll("-", "").slice(0, 12);
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Marker values by kind; each value is unique to one place it was sent. */
const markers = {
	env: [] as string[],
	secret: [] as string[],
	file: [] as string[],
	commandEnv: [] as string[],
	/** Issued by the API: secret of a key, token of a port, SSO code. */
	issued: [] as { value: string; answer: string }[],
	bearer: [] as string[],
};

function mark(kind: "env" | "secret" | "file" | "commandEnv", tag: string) {
	const v = `${kind}-${RUN}-${tag}`;
	markers[kind].push(v);
	return v;
}
const env = (tag: string) => ({ LEAK_ENV: mark("env", tag) });
const secrets = (tag: string) => ({ LEAK_SECRET: mark("secret", tag) });
const files = (tag: string) => [
	{
		name: `leak-${tag}`,
		contentBase64: b64(mark("file", tag)),
		linkPath: `/home/user/.leak-${tag}`,
	},
];
const filesPatch = (tag: string) => ({
	[`leak-${tag}`]: { contentBase64: b64(mark("file", tag)) },
});

/** Every form a value could take: as is and base64 (whole, as sent). */
function needles(values: string[]): string[] {
	return values.flatMap((v) => [v, b64(v)]);
}

interface Seen {
	label: string;
	method: string;
	status: number;
	text: string;
}

describe.skipIf(skipPg())("secrets never leak", () => {
	let db: TestDatabase;
	let boss: PgBoss;
	let w: ApiWorld;
	let oidc: TestOidcServer;
	let deps: Partial<ApiDeps>;
	let h: Harness;
	let owner: Person;
	const logs = captureLogs();
	const seen: Seen[] = [];
	const GW = `gw-${RUN}-0123456789abcdef`;

	/** The answer as searched: status, every header, then the body. */
	const serialized = (r: HarnessResponse) =>
		[
			String(r.status),
			...[...r.headers].map(([k, v]) => `${k}: ${v}`),
			"",
			r.text,
		].join("\n");

	/** Sends through `hh`, keeping the answer (headers and body) for the response checks. */
	async function call(
		hh: Harness,
		method: string,
		path: string,
		init: { json?: unknown; headers?: Record<string, string> } = {},
	): Promise<HarnessResponse & { serialized: string }> {
		const r = await hh.request(method, path, init);
		const text = serialized(r);
		seen.push({ label: `${method} ${path}`, method, status: r.status, text });
		return { ...r, serialized: text };
	}

	/** The worker's end of every active operation of a sandbox. */
	const finishActive = (sandboxId: string) =>
		db.pool.query(
			`UPDATE runtime.operations SET state = 'succeeded', finished_at = now()
			 WHERE sandbox_id = $1 AND state IN ('pending', 'running')`,
			[sandboxId],
		);

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		boss = new PgBoss({
			connectionString: db.url,
			schema: "pgboss",
			max: 2,
			supervise: false,
			schedule: false,
		});
		boss.on("error", () => {});
		await boss.start();
		await ensureQueues(boss);
		oidc = await startTestOidcServer();
		w = await apiWorld(db.pool);
		const jobs = new PgBossJobSender(boss);
		deps = {
			settings: testSettings({
				SBX_API_RATE_BURST: "100000",
				SBX_API_RATE_STARTS_PER_MIN: "100000",
				SBX_OIDC_ISSUER: oidc.issuer,
			}),
			log: logs.log,
			jobs,
			svc: new SandboxServiceImpl({
				pool: db.pool,
				config: w.env.config,
				keys: w.env.keys,
				jobs,
				log: logs.log,
			}),
			sshCa: testSshCa(),
			serviceTokens: new ServiceTokens({ gateway: [GW] }),
		};
		h = w.harness({ deps });
		owner = await personOf(w, w.teamId, "owner", deps);
		markers.bearer.push(w.secret, GW);
	});
	afterAll(async () => {
		await oidc?.close();
		await w?.close();
		await boss?.stop({ graceful: false });
		await db?.drop();
	});

	it("runs every secret-bearing request", async () => {
		// create with an Idempotency-Key, then its replay
		const createBody = {
			env: env("create"),
			secrets: secrets("create"),
			secretFiles: files("create"),
		};
		const created = ok(
			await call(h, "POST", "/v1/sandboxes", {
				json: createBody,
				headers: { "idempotency-key": `create-${RUN}` },
			}),
		);
		ok(
			await call(h, "POST", "/v1/sandboxes", {
				json: createBody,
				headers: { "idempotency-key": `create-${RUN}` },
			}),
		);
		// the same key with another body: 409, and no echo of either body
		const reused = await call(h, "POST", "/v1/sandboxes", {
			json: { ...createBody, secrets: secrets("reused") },
			headers: { "idempotency-key": `create-${RUN}` },
		});
		expect(reused.status).toBe(409);
		expect((reused.body as Any).error.code).toBe("idempotency_key_reused");
		const id = created.sandbox.id as string;
		const sb = `/v1/sandboxes/${id}`;
		const sandboxId = uuidOf("sandbox", id);
		await w.markReady(sandboxId);

		// env of the sandbox: PUT, PATCH, then reads
		ok(
			await call(h, "PUT", `${sb}/env`, {
				json: {
					env: env("put"),
					secrets: secrets("put"),
					secretFiles: files("put"),
				},
			}),
		);
		ok(
			await call(h, "PATCH", `${sb}/env`, {
				json: {
					env: env("patch"),
					secrets: secrets("patch"),
					secretFiles: filesPatch("patch"),
				},
			}),
		);
		ok(await call(h, "GET", `${sb}/env`));
		ok(await call(h, "GET", sb));
		ok(await call(h, "GET", "/v1/sandboxes"));

		// a command with env, and its reads
		const cmd = ok(
			await call(h, "POST", `${sb}/commands`, {
				json: {
					command: "true",
					mode: "detached",
					env: { LEAK_CMD: mark("commandEnv", "cmd") },
				},
				headers: { "idempotency-key": `cmd-${RUN}` },
			}),
		);
		ok(await call(h, "GET", `${sb}/commands/${cmd.id}`));
		ok(await call(h, "GET", `${sb}/commands`));

		// fork with a patch and an Idempotency-Key
		const forked = ok(
			await call(h, "POST", `${sb}/fork`, {
				json: {
					env: env("fork"),
					secrets: secrets("fork"),
					secretFiles: filesPatch("fork"),
				},
				headers: { "idempotency-key": `fork-${RUN}` },
			}),
		);
		ok(await call(h, "GET", `/v1/operations/${forked.operation.id}`));
		// The worker's part: the fork and the source's operation finish.
		await w.finishOperation(
			uuidOf("operation", forked.operation.id),
			"succeeded",
		);
		await finishActive(sandboxId);

		// stop, then resume with a patch
		ok(await call(h, "POST", `${sb}/stop`));
		await finishActive(sandboxId);
		await w.markState(sandboxId, "stopped");
		ok(
			await call(h, "POST", `${sb}/resume`, {
				json: {
					env: env("resume"),
					secrets: secrets("resume"),
					secretFiles: filesPatch("resume"),
				},
				headers: { "idempotency-key": `resume-${RUN}` },
			}),
		);
		await w.markReady(sandboxId);

		// refused bodies carrying secrets: validation errors must not echo them
		for (const json of [
			{ secrets: { "bad key": mark("secret", "badkey") } },
			{ secrets: { SBX_RESERVED: mark("secret", "reserved") } },
			{ env: { "1BAD": mark("env", "badenv") } },
			{
				secretFiles: [
					{ name: "../x", contentBase64: b64(mark("file", "badname")) },
				],
			},
			{ secrets: { OK: mark("secret", "unknownfield") }, extra: 1 },
		]) {
			const r = await call(h, "PUT", `${sb}/env`, { json });
			expect(r.status, JSON.stringify(json)).toBe(400);
		}

		// environments: create, update, reads
		const environment = ok(
			await call(h, "POST", "/v1/environments", {
				json: {
					name: `leak-${RUN}`,
					env: env("environment"),
					secrets: secrets("environment"),
					secretFiles: files("environment"),
				},
			}),
		);
		ok(
			await call(h, "PATCH", `/v1/environments/${environment.id}`, {
				json: {
					env: env("environment-patch"),
					secrets: secrets("environment-patch"),
					secretFiles: filesPatch("environment-patch"),
				},
			}),
		);
		ok(await call(h, "GET", `/v1/environments/${environment.id}`));
		ok(await call(h, "GET", "/v1/environments"));

		// a create through the environment
		ok(
			await call(h, "POST", "/v1/sandboxes", {
				json: { environment: environment.id, secrets: secrets("with-env") },
				headers: { "idempotency-key": `create-env-${RUN}` },
			}),
		);

		// API keys: issued by the owner (session) and by a Keycloak user (JWT)
		const issue = async (hh: Harness, headers: Record<string, string>) => {
			const r = await call(hh, "POST", "/v1/api-keys", {
				json: { name: `leak-${RUN}`, preset: "ci" },
				headers,
			});
			const k = ok(r);
			markers.issued.push({ value: k.secret, answer: r.serialized });
			const rot = await call(hh, "POST", `/v1/api-keys/${k.apiKey.id}/rotate`, {
				headers,
			});
			markers.issued.push({ value: ok(rot).secret, answer: rot.serialized });
			return ok(rot).secret as string;
		};
		const ownerKey = await issue(owner.h, owner.headers);
		const jwt = await oidc.token({
			sub: `sub-${RUN}`,
			email: `jwt-${RUN}@example.com`,
		});
		markers.bearer.push(jwt);
		const jh = createHarness({ deps: w.deps(deps), bearer: jwt });
		// refused bearers are not logged either
		const [head, payload, sig] = jwt.split(".") as [string, string, string];
		const forged = `${head}.${payload}.${sig.slice(0, -4)}AAAA`;
		const unknownKey = generateApiKeySecret();
		markers.bearer.push(forged, unknownKey);
		for (const bearer of [forged, unknownKey]) {
			const r = await call(
				createHarness({ deps: w.deps(deps), bearer }),
				"GET",
				"/v1/me",
			);
			expect(r.status).toBe(401);
		}
		ok(await call(jh, "GET", "/v1/me"));
		const jwtKey = await issue(jh, {});
		// The issued keys work (as bearers they are checked as issued values).
		ok(await call(w.harness({ bearer: ownerKey, deps }), "GET", "/v1/me"));
		ok(await call(w.harness({ bearer: jwtKey, deps }), "GET", "/v1/me"));
		ok(await call(owner.h, "GET", "/v1/api-keys", { headers: owner.headers }));

		// ports: issue and rotate a token, then list
		const port = await call(h, "PUT", `${sb}/ports/3000`, {
			json: { access: "token" },
		});
		markers.issued.push({ value: ok(port).token, answer: port.serialized });
		const rotated = await call(h, "POST", `${sb}/ports/3000/rotate-token`);
		markers.issued.push({
			value: ok(rotated).token,
			answer: rotated.serialized,
		});
		ok(await call(h, "GET", `${sb}/ports`));

		// port SSO: the browser gets a code, the gateway exchanges it
		const sso = ok(
			await call(h, "PUT", `${sb}/ports/3001`, { json: { access: "sso" } }),
		);
		const auth = await call(
			owner.h,
			"GET",
			`/sbx-auth/authorize?label=${sso.label}&state=st-${RUN}-0123456789`,
			{ headers: owner.headers },
		);
		expect(auth.status, auth.text).toBe(302);
		const code = new URL(auth.headers.get("location") ?? "").searchParams.get(
			"code",
		) as string;
		markers.issued.push({
			value: code,
			answer: auth.serialized,
		});
		const gw = createHarness({
			listener: "internal",
			deps: w.deps(deps),
			bearer: GW,
		});
		const exchanged = await call(
			gw,
			"POST",
			"/internal/v1/gateway/port-auth/exchange",
			{ json: { code, label: sso.label } },
		);
		expect(exchanged.status, exchanged.text).toBe(200);

		expect(markers.issued.every((m) => m.value.length >= 20)).toBe(true);
	});

	const SECRET_KINDS = () =>
		needles([...markers.secret, ...markers.file, ...markers.bearer]);
	const ALL = () =>
		needles([
			...markers.env,
			...markers.secret,
			...markers.file,
			...markers.commandEnv,
			...markers.bearer,
			...markers.issued.map((m) => m.value),
		]);

	const found = (text: string, values: string[]) =>
		values.filter((v) => text.includes(v));

	it("the logs of the api and the service carry none of them", () => {
		const text = logs.text();
		expect(text.length).toBeGreaterThan(1000);
		expect(found(text, ALL())).toEqual([]);
	});

	it("/metrics carries none of them", async () => {
		const ops = createHarness({ listener: "ops", deps: w.deps(deps) });
		const r = await ops.request("GET", "/metrics");
		expect(r.status).toBe(200);
		expect(found(r.text, ALL())).toEqual([]);
	});

	it("operations, idempotency keys, sandbox events and pg-boss jobs carry none of them", async () => {
		const q = async (sql: string) =>
			(await db.pool.query<{ j: string }>(sql)).rows.map((r) => r.j).join("\n");
		const stores = {
			operations: await q(
				"SELECT row_to_json(o)::text AS j FROM runtime.operations o",
			),
			idempotencyKeys: await q(
				"SELECT row_to_json(k)::text AS j FROM runtime.idempotency_keys k",
			),
			sandboxEvents: await q(
				"SELECT row_to_json(e)::text AS j FROM runtime.sandbox_events e",
			),
			pgbossJobData: await q(
				"SELECT row_to_json(j)::text AS j FROM pgboss.job j",
			),
		};
		expect(stores.idempotencyKeys).toContain(`create-${RUN}`);
		expect(stores.pgbossJobData.length).toBeGreaterThan(0);
		for (const [name, text] of Object.entries(stores)) {
			expect(found(text, ALL()), name).toEqual([]);
		}
	});

	it("no table holds a secret, a secret file, a bearer, a key secret, a port token or an SSO code in clear text", async () => {
		const tables = await db.pool.query<{ s: string; t: string }>(
			`SELECT table_schema AS s, table_name AS t FROM information_schema.tables
			 WHERE table_schema IN ('runtime', 'identity', 'pgboss', 'tunnel')
			   AND table_type = 'BASE TABLE'`,
		);
		const values = [
			...SECRET_KINDS(),
			...needles(markers.issued.map((m) => m.value)),
		];
		for (const { s, t } of tables.rows) {
			const r = await db.pool.query<{ j: string }>(
				`SELECT coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') AS j FROM "${s}"."${t}" x`,
			);
			expect(found(r.rows[0]?.j ?? "", values), `${s}.${t}`).toEqual([]);
		}
	});

	it("answers carry no secret or bearer; a key secret or port token only in the answer that issues it; env only where env is shown", () => {
		expect(seen.length).toBeGreaterThan(30);
		// The search finds what is there: env values in GET /env, each issued
		// value in its own answer.
		const getEnv = seen.filter(
			(s) => s.method === "GET" && s.label.endsWith("/env"),
		);
		expect(getEnv.some((s) => s.text.includes(`env-${RUN}-patch`))).toBe(true);
		for (const m of markers.issued) expect(m.answer).toContain(m.value);
		const showsEnv = (s: Seen) =>
			/\/env$/.test(s.label.split("?")[0] ?? "") ||
			s.label.includes("/v1/environments");
		for (const s of seen) {
			expect(found(s.text, SECRET_KINDS()), s.label).toEqual([]);
			expect(found(s.text, needles(markers.commandEnv)), s.label).toEqual([]);
			if (!showsEnv(s)) {
				expect(found(s.text, needles(markers.env)), s.label).toEqual([]);
			}
			for (const m of markers.issued) {
				if (s.text.includes(m.value)) {
					expect(m.answer, s.label).toBe(s.text);
				}
			}
		}
	});
});

/** The uuid of a public id (`sb_...`, `op_...`). */
function uuidOf(kind: "sandbox" | "operation", id: string): string {
	const uuid = decodeUuid(kind, id);
	if (uuid === null) throw new Error(`not a ${kind} id: ${id}`);
	return uuid;
}
