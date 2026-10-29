// File content (S7 §11.1): GET/HEAD streamed from the agent with Range,
// If-Range, ETag and download headers; PUT streamed to the agent without
// buffering; sandbox state, capability, agent outage, scopes and access.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentApi } from "../src/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
	sha256,
} from "./helpers/commands.ts";
import { bytesOf, filesUrl, qs, rawRequest } from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const err = (r: { body: unknown }) => (r.body as Any).error;

describe.skipIf(skipPg())("files content", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;
	let home: string;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
		home = w.agent.machine(sb.machineId).home;
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const content = (q: Record<string, string | undefined>, s = sb) =>
		filesUrl(s.ref, `/content${qs(q)}`);

	describe("GET and HEAD", () => {
		const data = randomBytes(1000);
		beforeAll(() => {
			writeFileSync(join(home, "data.bin"), data);
			mkdirSync(join(home, "dir"), { recursive: true });
		});

		it("streams the file with download headers", async () => {
			const res = await rawRequest(h, "GET", content({ path: "data.bin" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/octet-stream");
			expect(res.headers.get("content-disposition")).toBe(
				"attachment; filename*=UTF-8''data.bin",
			);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("accept-ranges")).toBe("bytes");
			expect(res.headers.get("etag")).toMatch(/^"[0-9]+-1000-[0-9]+"$/);
			expect(res.headers.get("last-modified")).not.toBeNull();
			expect(res.headers.get("content-length")).toBe("1000");
			expect((await bytesOf(res)).equals(data)).toBe(true);
		});

		it("an absolute path and a non-ASCII name", async () => {
			writeFileSync(join(home, "отчёт 1.txt"), "hi");
			const res = await rawRequest(
				h,
				"GET",
				content({ path: "/home/user/отчёт 1.txt" }),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-disposition")).toBe(
				`attachment; filename*=UTF-8''${encodeURIComponent("отчёт 1.txt")}`,
			);
			expect(await res.text()).toBe("hi");
		});

		it("Range: bytes=10-19 is 206 with 10 bytes", async () => {
			const res = await rawRequest(h, "GET", content({ path: "data.bin" }), {
				headers: { range: "bytes=10-19" },
			});
			expect(res.status).toBe(206);
			expect(res.headers.get("content-range")).toBe("bytes 10-19/1000");
			expect(res.headers.get("content-length")).toBe("10");
			const b = await bytesOf(res);
			expect(b.length).toBe(10);
			expect(b.equals(data.subarray(10, 20))).toBe(true);
		});

		it("If-Range with the current ETag keeps the range; another ETag gives the whole file", async () => {
			const head = await rawRequest(h, "HEAD", content({ path: "data.bin" }));
			const etag = head.headers.get("etag") ?? "";
			const same = await rawRequest(h, "GET", content({ path: "data.bin" }), {
				headers: { range: "bytes=10-19", "if-range": etag },
			});
			expect(same.status).toBe(206);
			expect((await bytesOf(same)).length).toBe(10);
			const other = await rawRequest(h, "GET", content({ path: "data.bin" }), {
				headers: { range: "bytes=10-19", "if-range": '"1-2-3"' },
			});
			expect(other.status).toBe(200);
			expect(other.headers.get("content-range")).toBeNull();
			expect((await bytesOf(other)).equals(data)).toBe(true);
		});

		it("a range past the end is 416 range_not_satisfiable", async () => {
			const r = await h.request("GET", content({ path: "data.bin" }), {
				headers: { range: "bytes=5000-" },
			});
			expect(r.status).toBe(416);
			expect(err(r).code).toBe("range_not_satisfiable");
			expect(r.headers.get("content-range")).toBe("bytes */1000");
		});

		it("HEAD: the headers without a body", async () => {
			const res = await rawRequest(h, "HEAD", content({ path: "data.bin" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-length")).toBe("1000");
			expect(res.headers.get("content-disposition")).toContain("data.bin");
			expect((await bytesOf(res)).length).toBe(0);
		});

		it("a directory is 409 is_directory (GET and HEAD)", async () => {
			const r = await h.request("GET", content({ path: "dir" }));
			expect(r.status).toBe(409);
			expect(err(r).code).toBe("is_directory");
			const head = await rawRequest(h, "HEAD", content({ path: "dir" }));
			expect(head.status).toBe(409);
		});

		it("a missing file is 404 path_not_found (GET and HEAD)", async () => {
			const r = await h.request("GET", content({ path: "nope" }));
			expect(r.status).toBe(404);
			expect(err(r).code).toBe("path_not_found");
			const head = await rawRequest(h, "HEAD", content({ path: "nope" }));
			expect(head.status).toBe(404);
		});

		it("a path above the root is 400 invalid_path", async () => {
			const r = await h.request(
				"GET",
				content({ path: "../../../etc/passwd" }),
			);
			expect(r.status).toBe(400);
			expect(err(r).code).toBe("invalid_path");
		});

		it("no path is 400 validation", async () => {
			const r = await h.request("GET", filesUrl(sb.ref, "/content"));
			expect(r.status).toBe(400);
			expect(err(r).code).toBe("validation");
		});
	});

	describe("PUT", () => {
		const put = (
			q: Record<string, string | undefined>,
			body: BodyInit,
			s = sb,
			hh = h,
		) =>
			hh.request("PUT", content(q, s), {
				headers: { "content-type": "application/octet-stream" },
				body,
			});

		it("writes the body and answers FileInfo", async () => {
			const data = randomBytes(70_000);
			const r = await put({ path: "up/new.bin" }, data);
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({
				path: "/home/user/up/new.bin",
				name: "new.bin",
				type: "file",
				sizeBytes: 70_000,
				mode: 0o644,
				symlinkTarget: null,
			});
			expect(typeof (r.body as Any).modifiedAt).toBe("string");
			expect(readFileSync(join(home, "up/new.bin")).equals(data)).toBe(true);
			const back = await rawRequest(h, "GET", content({ path: "up/new.bin" }));
			expect(sha256(await bytesOf(back))).toBe(sha256(data));
		});

		it("any content type and an empty body", async () => {
			const r = await h.request("PUT", content({ path: "empty.txt" }), {
				headers: { "content-type": "text/plain" },
				body: "",
			});
			expect(r.status).toBe(200);
			expect((r.body as Any).sizeBytes).toBe(0);
		});

		it("mode, overwrite=false and makeParents=false", async () => {
			const r = await put({ path: "run.sh", mode: "0755" }, "echo");
			expect((r.body as Any).mode).toBe(0o755);
			const again = await put({ path: "run.sh", overwrite: "false" }, "x");
			expect(again.status).toBe(409);
			expect(err(again).code).toBe("already_exists");
			const noParent = await put(
				{ path: "missing/dir/f", makeParents: "false" },
				"x",
			);
			expect(noParent.status).toBe(404);
			expect(err(noParent).code).toBe("path_not_found");
			const badMode = await put({ path: "m", mode: "999" }, "x");
			expect(badMode.status).toBe(400);
			expect(err(badMode).code).toBe("validation");
		});

		it("onto a directory is 409 is_directory", async () => {
			mkdirSync(join(home, "adir"), { recursive: true });
			const r = await put({ path: "adir" }, "x");
			expect(r.status).toBe(409);
			expect(err(r).code).toBe("is_directory");
		});

		it("a 5 MiB body is streamed to the agent, not held in memory", async () => {
			// The agent sees the body as a stream and counts what it read; the
			// client produces a chunk only when asked (pull), so the bytes in
			// flight between client and agent stay small if nothing buffers.
			const total = 5 * 1024 * 1024;
			const piece = 64 * 1024;
			let produced = 0;
			let consumed = 0;
			let maxInFlight = 0;
			let streamed = false;
			const agent = new Proxy(w.agent, {
				get(target, prop, receiver) {
					if (prop !== "files") {
						const v = Reflect.get(target, prop, receiver);
						return typeof v === "function" ? v.bind(target) : v;
					}
					return (
						m: string,
						path: string,
						init: Parameters<AgentApi["files"]>[2],
					) => {
						const body = init.body;
						if (body instanceof ReadableStream) {
							streamed = true;
							const counted = body.pipeThrough(
								new TransformStream<Uint8Array, Uint8Array>({
									transform(chunk, ctl) {
										consumed += chunk.length;
										ctl.enqueue(chunk);
									},
								}),
							);
							return target.files(m, path, { ...init, body: counted });
						}
						return target.files(m, path, init);
					};
				},
			});
			const hs = w.harness({ deps: { agent } });
			const data = randomBytes(total);
			const source = new ReadableStream<Uint8Array>(
				{
					pull(ctl) {
						if (produced >= total) {
							ctl.close();
							return;
						}
						const chunk = data.subarray(produced, produced + piece);
						produced += chunk.length;
						maxInFlight = Math.max(maxInFlight, produced - consumed);
						ctl.enqueue(new Uint8Array(chunk));
					},
				},
				{ highWaterMark: 0 },
			);
			const res = await rawRequest(hs, "PUT", content({ path: "big.bin" }), {
				headers: { "content-type": "application/octet-stream" },
				body: source,
			});
			expect(res.status).toBe(200);
			expect(((await res.json()) as Any).sizeBytes).toBe(total);
			expect(streamed).toBe(true);
			expect(consumed).toBe(total);
			expect(maxInFlight).toBeLessThan(1024 * 1024);
			expect(sha256(readFileSync(join(home, "big.bin")))).toBe(sha256(data));
		});
	});

	describe("state, capability, agent, scopes and access", () => {
		it("a stopped sandbox is 409 sandbox_not_ready", async () => {
			const s = await w.seed({ state: "stopped", machineState: "stopped" });
			const r = await h.request(
				"GET",
				`/v1/sandboxes/${s.slug}/files/content?path=x`,
			);
			expect(r.status).toBe(409);
			expect(err(r).code).toBe("sandbox_not_ready");
		});

		it("without files.v1 the answer is 409 agent_outdated", async () => {
			const s = await readySandbox(w);
			w.agent.machine(s.machineId).capabilities = ["process.v1"];
			const r = await h.request("GET", content({ path: "x" }, s));
			expect(r.status).toBe(409);
			expect(err(r)).toMatchObject({
				code: "agent_outdated",
				details: { capability: "files.v1" },
			});
		});

		it("an unreachable agent is 503 agent_unavailable (retryable)", async () => {
			const s = await readySandbox(w);
			w.agent.machine(s.machineId);
			w.agent.setUnavailable(s.machineId, true);
			try {
				const r = await h.request("GET", content({ path: "x" }, s));
				expect(r.status).toBe(503);
				expect(err(r)).toMatchObject({
					code: "agent_unavailable",
					retryable: true,
				});
			} finally {
				w.agent.setUnavailable(s.machineId, false);
			}
		});

		it("files:read cannot PUT; files:write is needed", async () => {
			const { secret } = await w.key(["files:read"]);
			const hr = w.harness({ bearer: secret });
			const get = await hr.request("GET", content({ path: "data.bin" }));
			expect(get.status).toBe(200);
			const r = await hr.request("PUT", content({ path: "x" }), {
				headers: { "content-type": "application/octet-stream" },
				body: "x",
			});
			expect(r.status).toBe(403);
			expect(err(r).details).toEqual({ requiredScope: "files:write" });
		});

		it("another team's sandbox is 404 not_found", async () => {
			const foreignTeam = randomUUID();
			await db.pool.query(
				"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
				[foreignTeam, `t-${foreignTeam}`],
			);
			const other = await readySandbox(w, foreignTeam);
			const r = await h.request("GET", content({ path: "x" }, other));
			expect(r.status).toBe(404);
			expect(err(r).code).toBe("not_found");
		});

		it("proxied: GET with ?team=, PUT with the dashboard Origin", async () => {
			const { h: ph, headers } = w.session();
			const teamId = encodeUuid("team", w.teamId);
			writeFileSync(join(home, "p.txt"), "proxied");
			const get = await rawRequest(
				ph,
				"GET",
				`${content({ path: "p.txt" })}&team=${teamId}`,
				{ headers },
			);
			expect(get.status).toBe(200);
			expect(await get.text()).toBe("proxied");
			const put = await ph.request("PUT", content({ path: "p2.txt" }), {
				headers: { ...headers, "content-type": "application/octet-stream" },
				body: "x",
			});
			expect(put.status).toBe(200);
		});
	});
});
