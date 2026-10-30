// In-memory fake of the sbx public API v1 and the S10 desktop routes, for the
// contract tests of the MCP server (S11 §14.2).
//
//   const api = await startFakeApi();
//   const sbx = new Sbx({ baseUrl: api.url, apiKey: FAKE_TOKENS.full });
//   ...
//   expect(api.contractErrors).toEqual([]);   // every request and response fit the OpenAPI document
//   await api.close();
//
// Every request and response goes through openapi-check.ts; mismatches land
// in `contractErrors` (a request that does not fit is also answered 400, as
// the real API would). Scopes are enforced by the route table in `SCOPES`.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import {
	errorBody,
	FakeApiError,
	forbidden,
	noRoute,
	validation,
} from "./errors.ts";
import { Contract, type MatchedOperation } from "./openapi-check.ts";
import { registerCommandRoutes } from "./routes-commands.ts";
import { registerDesktopRoutes } from "./routes-desktop.ts";
import { registerFileRoutes } from "./routes-files.ts";
import { registerPortRoutes } from "./routes-ports.ts";
import { registerSandboxRoutes } from "./routes-sandboxes.ts";
import { registerSnapshotRoutes } from "./routes-snapshots.ts";
import {
	createState,
	FAKE_TEAM,
	type Fake,
	type FakeApiOptions,
	type FakeEnv,
	type FakePrincipal,
	type FakeScript,
	type FakeState,
	FULL_SCOPES,
	OTHER_TEAM,
	READ_ONLY_SCOPES,
} from "./state.ts";

export { scaleToFit } from "./images.ts";
export {
	EMIT_UNIT,
	emitPattern,
	INJECT_FENCE_END,
	injectText,
} from "./scenario.ts";
export type {
	CommandStatus,
	FakeApiOptions,
	FakeCommand,
	FakeDesktopAction,
	FakeOperation,
	FakePort,
	FakePrincipal,
	FakeSandbox,
	FakeScript,
	FakeSnapshot,
	FakeState,
	SandboxState,
} from "./state.ts";
export {
	FAKE_TEAM,
	FULL_SCOPES,
	OTHER_TEAM,
	READ_ONLY_SCOPES,
} from "./state.ts";
export type { SandboxFs } from "./vfs.ts";
export { HOME } from "./vfs.ts";

export interface FakeApi {
	/** http://127.0.0.1:<port> */
	url: string;
	/** Bearer token -> principal; add your own for a scenario. */
	tokens: Map<string, FakePrincipal>;
	/** "METHOD /path" of every request, in order. */
	journal: string[];
	state: FakeState;
	/** Per-test faults. */
	script: FakeScript;
	/** OpenAPI mismatches (and fake bugs); tests assert it stays empty. */
	contractErrors: string[];
	close(): Promise<void>;
}

/** The bearer tokens every fake starts with. */
export const FAKE_TOKENS = {
	/** Team key, all scopes, team FAKE_TEAM. */
	full: "sbx_fake_full",
	/** A person (Keycloak token), all scopes, team FAKE_TEAM. */
	oidc: "fake_oidc_user",
	/** Team key with the `read-only` preset. */
	readOnly: "sbx_fake_readonly",
	/** Team key, all scopes, team OTHER_TEAM. */
	otherTeam: "sbx_fake_other_team",
} as const;

/** Scope of every route (S7 §7.3, S10 §13.1); routes not listed need any valid credential. */
const SCOPES: Record<string, string> = {
	"GET /v1/sandboxes": "sandboxes:read",
	"POST /v1/sandboxes": "sandboxes:write",
	"GET /v1/sandboxes/{sandbox}": "sandboxes:read",
	"PATCH /v1/sandboxes/{sandbox}": "sandboxes:write",
	"DELETE /v1/sandboxes/{sandbox}": "sandboxes:delete",
	"POST /v1/sandboxes/{sandbox}/stop": "sandboxes:write",
	"POST /v1/sandboxes/{sandbox}/resume": "sandboxes:write",
	"POST /v1/sandboxes/{sandbox}/fork": "sandboxes:write",
	"POST /v1/sandboxes/{sandbox}/recover": "sandboxes:write",
	"GET /v1/operations/{operation}": "sandboxes:read",
	"GET /v1/sandboxes/{sandbox}/commands": "commands:read",
	"POST /v1/sandboxes/{sandbox}/commands": "commands:exec",
	"GET /v1/sandboxes/{sandbox}/commands/{command}": "commands:read",
	"GET /v1/sandboxes/{sandbox}/commands/{command}/output": "commands:read",
	"GET /v1/sandboxes/{sandbox}/commands/{command}/stream": "commands:read",
	"POST /v1/sandboxes/{sandbox}/commands/{command}/kill": "commands:exec",
	"POST /v1/sandboxes/{sandbox}/commands/{command}/signal": "commands:exec",
	"GET /v1/sandboxes/{sandbox}/files/content": "files:read",
	"GET /v1/sandboxes/{sandbox}/files/stat": "files:read",
	"GET /v1/sandboxes/{sandbox}/files/list": "files:read",
	"PUT /v1/sandboxes/{sandbox}/files/content": "files:write",
	"DELETE /v1/sandboxes/{sandbox}/files": "files:write",
	"GET /v1/sandboxes/{sandbox}/ports": "sandboxes:read",
	"PUT /v1/sandboxes/{sandbox}/ports/{port}": "ports:write",
	"DELETE /v1/sandboxes/{sandbox}/ports/{port}": "ports:write",
	"POST /v1/sandboxes/{sandbox}/ports/{port}/rotate-token": "ports:write",
	"GET /v1/snapshots": "snapshots:read",
	"GET /v1/snapshots/{name}": "snapshots:read",
	"POST /v1/snapshots": "snapshots:write",
	"DELETE /v1/snapshots/{name}": "snapshots:write",
	"GET /v1/sandboxes/{sandbox}/desktop": "sandboxes:read",
	"POST /v1/sandboxes/{sandbox}/desktop/links": "desktop",
	"GET /v1/sandboxes/{sandbox}/desktop/screenshot": "desktop",
	"POST /v1/sandboxes/{sandbox}/desktop/actions": "desktop",
	"GET /v1/sandboxes/{sandbox}/desktop/clipboard": "desktop",
	"PUT /v1/sandboxes/{sandbox}/desktop/clipboard": "desktop",
};

// Compiling the document takes long: every fake in a test process shares one.
let contract: Contract | undefined;
function sharedContract(): Contract {
	contract ??= new Contract();
	return contract;
}

const DESKTOP_PATH = /^\/v1\/sandboxes\/[^/]+\/desktop(\/|$)/;

export async function startFakeApi(o: FakeApiOptions = {}): Promise<FakeApi> {
	const filesRoot = await mkdtemp(join(tmpdir(), "sbx-fake-api-"));
	const state = createState(filesRoot, {
		readyAfterMs: o.readyAfterMs ?? 50,
		screen: o.screen ?? { width: 1920, height: 1080 },
	});
	const tokens = new Map<string, FakePrincipal>([
		[
			FAKE_TOKENS.full,
			{
				kind: "team_key",
				scopes: [...FULL_SCOPES],
				teamId: FAKE_TEAM,
				keyId: "key_fake_full",
			},
		],
		[
			FAKE_TOKENS.oidc,
			{
				kind: "oidc",
				scopes: [...FULL_SCOPES],
				teamId: FAKE_TEAM,
				userEmail: "user@example.com",
			},
		],
		[
			FAKE_TOKENS.readOnly,
			{
				kind: "team_key",
				scopes: [...READ_ONLY_SCOPES],
				teamId: FAKE_TEAM,
				keyId: "key_fake_ro",
			},
		],
		[
			FAKE_TOKENS.otherTeam,
			{
				kind: "team_key",
				scopes: [...FULL_SCOPES],
				teamId: OTHER_TEAM,
				keyId: "key_fake_other",
			},
		],
	]);
	for (const [token, p] of Object.entries(o.tokens ?? {})) tokens.set(token, p);

	const closedCtl = new AbortController();
	const timers = new Set<NodeJS.Timeout>();
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	let idCounter = 0;
	let seqCounter = 0;
	let requestCounter = 0;

	const fake: Fake = {
		opts: {
			heartbeatMs: o.heartbeatMs ?? 500,
			retentionBytes: o.retentionBytes ?? Number.POSITIVE_INFINITY,
			startWaitMs: o.startWaitMs ?? 60_000,
			quota: {
				maxActiveSandboxes: o.quota?.maxActiveSandboxes ?? 10,
				maxRamMb: o.quota?.maxRamMb ?? 32_768,
				maxSavedSnapshots: o.quota?.maxSavedSnapshots ?? 20,
			},
		},
		state,
		script: {},
		tokens,
		journal: [],
		contractErrors: [],
		contract: sharedContract(),
		bus,
		closed: closedCtl.signal,
		newId: (prefix) => `${prefix}_fake${String(++idCounter).padStart(4, "0")}`,
		nextSeq: () => ++seqCounter,
		later(ms, fn) {
			const t = setTimeout(() => {
				timers.delete(t);
				if (!closedCtl.signal.aborted) fn();
			}, ms);
			t.unref();
			timers.add(t);
			return t;
		},
		sleep(ms, signal) {
			return new Promise((resolve) => {
				const done = () => {
					clearTimeout(t);
					signal?.removeEventListener("abort", done);
					closedCtl.signal.removeEventListener("abort", done);
					resolve();
				};
				const t = setTimeout(done, ms);
				signal?.addEventListener("abort", done, { once: true });
				closedCtl.signal.addEventListener("abort", done, { once: true });
			});
		},
		waitUntil(pred, ms, signal) {
			return new Promise<boolean>((resolve) => {
				if (pred()) return resolve(true);
				if (signal?.aborted || closedCtl.signal.aborted) return resolve(false);
				const finish = (v: boolean) => {
					clearTimeout(timer);
					bus.off("change", check);
					signal?.removeEventListener("abort", onAbort);
					closedCtl.signal.removeEventListener("abort", onAbort);
					resolve(v);
				};
				const check = () => {
					if (pred()) finish(true);
				};
				const onAbort = () => finish(false);
				const timer = setTimeout(() => finish(pred()), ms);
				bus.on("change", check);
				signal?.addEventListener("abort", onAbort, { once: true });
				closedCtl.signal.addEventListener("abort", onAbort, { once: true });
			});
		},
		notify: () => {
			bus.emit("change");
		},
	};

	const app = new Hono<FakeEnv>();

	function render(c: Context<FakeEnv>, e: FakeApiError): Response {
		const requestId = c.get("requestId");
		const headers: Record<string, string> = {
			...e.headers,
			"Request-Id": requestId,
		};
		if (e.status === 429 || e.status === 503) {
			const hint = e.details.retryAfterSeconds;
			headers["Retry-After"] = String(typeof hint === "number" ? hint : 1);
		}
		return c.json(errorBody(e, requestId), e.status as 400, headers);
	}

	function authenticate(
		authorization: string | undefined,
		teamHeader: string | undefined,
	): {
		token: string;
		principal: FakePrincipal;
	} {
		const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
		if (!m) {
			throw new FakeApiError(
				401,
				"unauthorized",
				"authentication required: send Authorization: Bearer <token>",
			);
		}
		const token = m[1] as string;
		const principal = tokens.get(token);
		if (!principal) {
			throw new FakeApiError(
				401,
				"unauthorized",
				"the credential is not valid",
				{
					details: { reason: "invalid_token" },
				},
			);
		}
		if (fake.script.expireTokenOnce === token) {
			delete fake.script.expireTokenOnce;
			throw new FakeApiError(
				401,
				"token_expired",
				"the access token has expired; refresh it and retry",
			);
		}
		if (principal.disabled) {
			throw forbidden("the user is disabled", { reason: "user_disabled" });
		}
		if (
			principal.expiresAt !== undefined &&
			Date.parse(principal.expiresAt) < Date.now()
		) {
			throw new FakeApiError(
				401,
				principal.kind === "oidc" ? "token_expired" : "api_key_expired",
				"the credential has expired",
			);
		}
		return { token, principal: withTeam(principal, teamHeader) };
	}

	/**
	 * The team of the request (Sbx-Team, else the default), as the real API
	 * selects it (apps/api/src/auth/public.ts, principal.ts): checked only
	 * after the credential passed.
	 */
	function withTeam(
		p: FakePrincipal,
		header: string | undefined,
	): FakePrincipal {
		if (header === undefined) return p;
		const team = header.trim();
		if (!/^team_\S+$/.test(team)) {
			throw validation([
				{ path: "header.sbx-team", message: "must be a team id (team_...)" },
			]);
		}
		if (team === p.teamId) return p;
		if (p.kind === "team_key") {
			throw new FakeApiError(
				403,
				"team_forbidden",
				"the API key belongs to another team than Sbx-Team",
			);
		}
		if (!(p.teams ?? []).includes(team)) {
			throw new FakeApiError(
				403,
				"team_forbidden",
				"you are not a member of the team in Sbx-Team",
			);
		}
		return { ...p, teamId: team };
	}

	async function checkRequest(
		c: Context<FakeEnv>,
		m: MatchedOperation,
	): Promise<void> {
		const needed = SCOPES[`${m.method} ${m.template}`];
		if (needed !== undefined && !c.get("principal").scopes.includes(needed)) {
			throw forbidden(
				`the API key lacks the scope ${needed}; a team owner can issue a key with it`,
				{
					requiredScope: needed,
				},
			);
		}
		const wantsJson = Boolean(
			(
				m.operation.requestBody as
					| { content?: Record<string, unknown> }
					| undefined
			)?.content?.["application/json"],
		);
		let body: { present: boolean; value?: unknown } = { present: false };
		const issues: string[] = [];
		if (wantsJson) {
			const text = await c.req.text();
			if (text.trim() !== "") {
				try {
					body = { present: true, value: JSON.parse(text) };
				} catch {
					fake.contractErrors.push(
						`${m.method} ${m.template}: the request body is not JSON`,
					);
					throw new FakeApiError(
						400,
						"invalid_json",
						"the request body is not valid JSON",
					);
				}
				c.set("json", body.value);
			}
		}
		issues.push(
			...fake.contract.validateRequest(m, {
				query: new URL(c.req.url).searchParams,
				headers: c.req.raw.headers,
				body,
			}),
		);
		if (issues.length > 0) {
			fake.contractErrors.push(...issues);
			throw validation(issues.map((message) => ({ path: "request", message })));
		}
	}

	app.use("*", async (c, next) => {
		const requestId = `req_fake_${String(++requestCounter).padStart(5, "0")}`;
		c.set("requestId", requestId);
		c.header("Request-Id", requestId);
		const method = c.req.method;
		const path = new URL(c.req.url).pathname;
		fake.journal.push(`${method} ${path}`);
		const matched = fake.contract.match(method, path);
		try {
			if (fake.script.noDesktopRoutes && DESKTOP_PATH.test(path))
				throw noRoute(method, path);
			const auth = authenticate(
				c.req.header("Authorization"),
				c.req.header("Sbx-Team"),
			);
			c.set("token", auth.token);
			c.set("principal", auth.principal);
			const fail = fake.script.failNext;
			if (fail?.path.test(`${method} ${path}`)) {
				delete fake.script.failNext;
				throw new FakeApiError(
					fail.status,
					fail.code,
					`injected failure ${fail.code}`,
					{
						retryable: fail.retryable,
						details:
							fail.status === 429 || fail.status === 503
								? { retryAfterSeconds: 1 }
								: {},
					},
				);
			}
			if (matched) await checkRequest(c, matched);
			const bad = fake.script.badResponse;
			if (bad?.path.test(`${method} ${path}`)) {
				delete fake.script.badResponse;
				c.res = c.json(bad.body as never, (bad.status ?? 200) as 200);
			} else {
				await next();
			}
		} catch (e) {
			c.res = render(c, e instanceof FakeApiError ? e : unexpected(e));
		}
		if (c.req.raw.signal.aborted) return;
		const res = c.res;
		const type = res.headers.get("content-type") ?? "";
		let json: unknown;
		if (type.startsWith("application/json")) {
			try {
				json = await res.clone().json();
			} catch {
				fake.contractErrors.push(
					`${method} ${path} -> ${res.status}: the JSON body does not parse`,
				);
			}
		}
		fake.contractErrors.push(
			...fake.contract.validateResponse(matched, {
				status: res.status,
				headers: res.headers,
				json,
			}),
		);
	});

	function unexpected(e: unknown): FakeApiError {
		fake.contractErrors.push(
			`fake bug: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
		);
		return new FakeApiError(500, "internal", "internal error in the fake API");
	}

	app.onError((e, c) =>
		render(c, e instanceof FakeApiError ? e : unexpected(e)),
	);
	app.notFound((c) =>
		render(c, noRoute(c.req.method, new URL(c.req.url).pathname)),
	);

	registerSandboxRoutes(app, fake);
	registerCommandRoutes(app, fake);
	registerFileRoutes(app, fake);
	registerPortRoutes(app, fake);
	registerSnapshotRoutes(app, fake);
	registerDesktopRoutes(app, fake);

	const server = await new Promise<{ server: Server; port: number }>(
		(resolve) => {
			const s = serve(
				{ fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
				(info) => resolve({ server: s as Server, port: info.port }),
			);
		},
	);

	return {
		url: `http://127.0.0.1:${server.port}`,
		tokens,
		journal: fake.journal,
		state,
		script: fake.script,
		contractErrors: fake.contractErrors,
		async close() {
			closedCtl.abort();
			for (const t of timers) clearTimeout(t);
			timers.clear();
			server.server.closeAllConnections();
			await new Promise<void>((resolve) =>
				server.server.close(() => resolve()),
			);
			await rm(filesRoot, { recursive: true, force: true });
		},
	};
}
