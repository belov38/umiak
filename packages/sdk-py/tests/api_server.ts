// The api of the pytest suite (run by tests/conftest.py with `node`):
// apps/api's public app on a real HTTP server, Postgres (UMIAK_TEST_DATABASE_URL
// or a docker container, as @umiak/db/testing/global-setup), core's
// SandboxService over a test topology, a FakeAgent and a team key with every
// scope (the same world as packages/sdk-ts/test/helpers/api.ts).
//
// Two more servers on 127.0.0.1:
// - a fault proxy in front of the api: the SDK talks to it; it records every
//   request and applies one-shot faults (replace the answer, cut or stall the
//   body after N bytes, drop the connection after the api answered);
// - a control server (JSON) for the tests: requests, faults, the worker's
//   part (mark-ready, fail-operation), FakeAgent controls (attach failures,
//   chunk size), new keys.
//
// Prints one JSON line {url, apiUrl, control, secret} (or {skip}) on stdout
// and runs until stdin closes or SIGTERM; then drops the database and
// removes the container.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer, createPublicApp } from "@umiak/api";
import {
	FakeAgent,
	type FakeAttachFailure,
	issueApiKey,
	makeTestDeps,
	testSettings,
} from "@umiak/api/testing";
import { serviceEnv } from "@umiak/core/testing";
import { createPool, withTx } from "@umiak/db";
import { setup, teardown } from "@umiak/db/testing/global-setup";
import { createDatabase, dropDatabase } from "@umiak/db/testing/pg";

interface Fault {
	method?: string;
	/** The request path (with query) contains this. */
	pathIncludes?: string;
	/** The path (without query) ends with this. */
	pathEndsWith?: string;
	/** Applies to the n-th matching request (1-based, default 1). */
	nth?: number;
	/**
	 * replace: answer `status` with `body` instead (the api still ran it);
	 * cut: pass `bytes` of the body, then break the connection;
	 * stall: pass `bytes` of the body, then send nothing more;
	 * drop: close the connection after the api answered, without an answer.
	 */
	action: "replace" | "cut" | "stall" | "drop";
	status?: number;
	body?: string;
	bytes?: number;
	/** Before a cut breaks the connection: this request to the api (e.g. a file write). */
	before?: { method: string; path: string; bodyBase64?: string };
	/** Matching requests seen so far. */
	seen?: number;
}

interface Logged {
	method: string;
	path: string;
	headers: Record<string, string>;
}

async function adminDsn(): Promise<string | null> {
	const provided: Record<string, string> = {};
	await setup({
		provide: (k: string, v: string) => {
			provided[k] = v;
		},
	} as never);
	if (provided.umiakPgError) throw new Error(provided.umiakPgError);
	return provided.umiakPgAdminDsn ? provided.umiakPgAdminDsn : null;
}

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port),
		);
	});
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		req.on("data", (b: Buffer) => parts.push(b));
		req.on("end", () => resolve(Buffer.concat(parts)));
		req.on("error", reject);
	});
}

async function main() {
	const admin = await adminDsn();
	if (admin === null) {
		process.stdout.write(
			`${JSON.stringify({ skip: "UMIAK_TEST_SKIP_PG=1" })}\n`,
		);
		await teardown();
		return;
	}
	// The same template, lock and copy as createTestDatabase of @umiak/db/testing.
	const { name: dbName, url: dbUrl } = await createDatabase(admin);
	const pool = createPool(dbUrl, 20);
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
	const apiPort = await listen(server);

	const requests: Logged[] = [];
	const faults: Fault[] = [];
	const proxy = http.createServer((req, res) => {
		void forward(req, res).catch(() => {
			req.socket.destroy();
		});
	});

	const takeFault = (method: string, path: string): Fault | undefined => {
		const bare = path.split("?")[0] ?? path;
		for (const f of faults) {
			if (f.method !== undefined && f.method !== method) continue;
			if (f.pathIncludes !== undefined && !path.includes(f.pathIncludes))
				continue;
			if (f.pathEndsWith !== undefined && !bare.endsWith(f.pathEndsWith))
				continue;
			f.seen = (f.seen ?? 0) + 1;
			if (f.seen === (f.nth ?? 1)) {
				faults.splice(faults.indexOf(f), 1);
				return f;
			}
		}
		return undefined;
	};

	const apiRequest = async (b: NonNullable<Fault["before"]>) => {
		const res = await fetch(`http://127.0.0.1:${apiPort}${b.path}`, {
			method: b.method,
			headers: {
				Authorization: `Bearer ${secret}`,
				"Content-Type": "application/octet-stream",
			},
			...(b.bodyBase64 === undefined
				? {}
				: { body: Buffer.from(b.bodyBase64, "base64") }),
		});
		await res.arrayBuffer();
	};

	async function forward(req: http.IncomingMessage, res: http.ServerResponse) {
		const method = req.method ?? "GET";
		const path = req.url ?? "/";
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
		}
		requests.push({ method, path, headers });
		const body = await readBody(req);
		const fault = takeFault(method, path);
		const up = http.request({
			host: "127.0.0.1",
			port: apiPort,
			method,
			path,
			headers: req.headers,
		});
		res.on("close", () => up.destroy());
		up.on("error", () => req.socket.destroy());
		up.on("response", (ures) => {
			const status = ures.statusCode ?? 502;
			if (fault?.action === "replace" || fault?.action === "drop") {
				// The api ran the request; its answer (a stream too) is thrown away.
				ures.destroy();
				if (fault.action === "drop") {
					req.socket.destroy();
					return;
				}
				res.writeHead(fault.status ?? 503, { "Content-Type": "text/html" });
				res.end(fault.body ?? "<html>503 Service Unavailable</html>");
				return;
			}
			res.writeHead(status, ures.headers);
			if (fault === undefined) {
				ures.pipe(res);
				return;
			}
			const limit = fault.bytes ?? 0;
			let sent = 0;
			let done = false;
			ures.on("data", (chunk: Buffer) => {
				if (done) return;
				const part = chunk.subarray(0, limit - sent);
				sent += part.length;
				if (sent < limit) {
					res.write(part);
					return;
				}
				done = true;
				ures.destroy();
				// Once the bytes are flushed: a stall sends nothing more (the
				// connection stays open), a cut ends the connection mid-body.
				res.write(part, () => {
					if (fault.action === "stall") return;
					void (async () => {
						if (fault.before) await apiRequest(fault.before).catch(() => {});
						req.socket.end();
					})();
				});
			});
			ures.on("end", () => {
				if (!done) res.end();
			});
		});
		up.end(body);
	}

	const proxyPort = await listen(proxy);

	const coreCommandId = (id: string) => id.slice(4).toUpperCase();
	const sandboxRow = async (slug: string) => {
		const r = await pool.query<{ id: string; machine_id: string | null }>(
			"SELECT id, machine_id FROM runtime.sandboxes WHERE slug = $1",
			[slug],
		);
		const row = r.rows[0];
		if (row === undefined) throw new Error(`no sandbox ${slug}`);
		return row;
	};

	const control = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://control");
			const raw = await readBody(req);
			const input = (raw.length ? JSON.parse(raw.toString()) : {}) as Record<
				string,
				unknown
			>;
			const q = url.searchParams;
			const route = `${req.method} ${url.pathname}`;
			let out: unknown;
			switch (route) {
				case "GET /requests":
					out = requests.slice(Number(q.get("since") ?? 0));
					break;
				case "GET /requests/count":
					out = { count: requests.length };
					break;
				case "POST /faults":
					faults.push(input as unknown as Fault);
					out = { ok: true };
					break;
				case "DELETE /faults":
					faults.length = 0;
					out = { ok: true };
					break;
				case "GET /creating": {
					const r = await pool.query<{ slug: string }>(
						"SELECT slug FROM runtime.sandboxes WHERE team_id = $1 AND state = 'creating' ORDER BY created_at",
						[teamId],
					);
					out = { slugs: r.rows.map((x) => x.slug) };
					break;
				}
				case "POST /mark-ready": {
					const { id } = await sandboxRow(String(input.slug));
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
					out = { ok: true };
					break;
				}
				case "POST /fail-operation": {
					// The worker's end of a failed operation of `kind` on a sandbox.
					const { id } = await sandboxRow(String(input.slug));
					const r = await pool.query(
						`UPDATE runtime.operations
						 SET state = 'failed', error_code = $3, error_message = $4,
						     retryable = false, started_at = now(), finished_at = now()
						 WHERE sandbox_id = $1 AND kind = $2 AND state IN ('pending', 'running')`,
						[id, input.kind, input.code, input.message],
					);
					out = { ok: (r.rowCount ?? 0) > 0 };
					break;
				}
				case "GET /start-count":
					out = {
						count: agent.startCount(coreCommandId(q.get("command") ?? "")),
					};
					break;
				case "POST /fail-next-attach": {
					const { machine_id } = await sandboxRow(String(input.slug));
					agent.failNextAttach(
						machine_id as string,
						Number(input.afterBytes),
						input.kind as FakeAttachFailure,
					);
					out = { ok: true };
					break;
				}
				case "POST /agent-chunk-size": {
					// Max bytes of one agent data event (1: frames split inside characters).
					const previous = agent.chunkSize;
					agent.chunkSize = Number(input.size);
					out = { previous };
					break;
				}
				case "POST /key": {
					const { secret: s } = await issueApiKey(deps.identity, {
						teamId,
						...(input.scopes === undefined
							? {}
							: { scopes: input.scopes as never }),
					});
					out = { secret: s };
					break;
				}
				default:
					res.writeHead(404).end();
					return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(out));
		})().catch((err: unknown) => {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end(String(err instanceof Error ? err.stack : err));
		});
	});
	const controlPort = await listen(control);

	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		for (const ws of wss.clients) ws.terminate();
		for (const s of [proxy, control, server]) s.closeAllConnections();
		await Promise.all(
			[proxy, control, server].map(
				(s) => new Promise<void>((r) => s.close(() => r())),
			),
		);
		deps.streams.close();
		await agent.close();
		await pool.end();
		await dropDatabase(admin, dbName).catch(() => {});
		await teardown();
		process.exit(0);
	};
	process.on("SIGTERM", () => void close());
	process.on("SIGINT", () => void close());
	process.stdin.on("end", () => void close());
	process.stdin.on("close", () => void close());
	process.stdin.resume();

	process.stdout.write(
		`${JSON.stringify({
			url: `http://127.0.0.1:${proxyPort}`,
			apiUrl: `http://127.0.0.1:${apiPort}`,
			control: `http://127.0.0.1:${controlPort}`,
			secret,
		})}\n`,
	);
}

main().catch(async (err: unknown) => {
	process.stderr.write(
		`api_server: ${String(err instanceof Error ? err.stack : err)}\n`,
	);
	await teardown().catch(() => {});
	process.exit(1);
});
