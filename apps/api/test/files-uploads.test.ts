// Resumable uploads (S7 §11.1): POST, chunks with offsets, HEAD, commit
// with sha256, DELETE; a 100 MiB upload interrupted after the third chunk
// and resumed from HEAD; upload ids of another sandbox are not visible.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
	sha256,
} from "./helpers/commands.ts";
import { filesUrl, qs, rawRequest, withFiles } from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const MiB = 1024 * 1024;
const err = (r: { body: unknown }) => (r.body as Any).error;

describe.skipIf(skipPg())("files uploads", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const uploads = (s = sb, rest = "") => filesUrl(s.ref, `/uploads${rest}`);

	async function begin(path: string, s = sb): Promise<string> {
		const r = await h.request("POST", uploads(s), { json: { path } });
		expect(r.status).toBe(201);
		return (r.body as Any).uploadId;
	}

	function chunk(
		id: string,
		offset: number,
		data: Uint8Array,
		path?: string,
		s = sb,
	) {
		return h.request("PUT", uploads(s, `/${id}${qs({ offset, path })}`), {
			headers: { "content-type": "application/octet-stream" },
			body: data as Uint8Array<ArrayBuffer>,
		});
	}

	async function offsetOf(id: string, s = sb): Promise<number | null> {
		const res = await rawRequest(h, "HEAD", uploads(s, `/${id}`));
		if (res.status === 404) return null;
		expect(res.status).toBe(200);
		return Number(res.headers.get("sbx-upload-offset"));
	}

	it("POST answers the upload id, chunk sizes and expiry", async () => {
		const before = Date.now();
		const r = await h.request("POST", uploads(), { json: { path: "a.bin" } });
		expect(r.status).toBe(201);
		const b = r.body as Any;
		expect(b.uploadId).toMatch(/^upl_[0-9a-z]{26}$/);
		expect(b.chunkSizeBytes).toBe(4194304);
		expect(b.maxChunkSizeBytes).toBe(8388608);
		const exp = Date.parse(b.expiresAt) - before;
		expect(exp).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
		expect(exp).toBeLessThanOrEqual(24 * 3600_000 + 5000);
		// Nothing exists at the agent until the first chunk.
		expect(await offsetOf(b.uploadId)).toBeNull();
	});

	it("100 MiB in 4 MiB chunks, interrupted after the 3rd and resumed from HEAD", async () => {
		const total = 100 * MiB;
		const size = 4 * MiB;
		const data = randomBytes(total);
		const id = await begin("big/upload.bin");
		for (let i = 0; i < 3; i++) {
			const off = i * size;
			const r = await chunk(
				id,
				off,
				data.subarray(off, off + size),
				"big/upload.bin",
			);
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ offset: off + size });
			expect(r.headers.get("sbx-upload-offset")).toBe(String(off + size));
		}
		// The 4th chunk breaks after 1 MiB: nothing of it reaches the agent.
		let sent = false;
		const broken = new ReadableStream<Uint8Array>({
			pull(ctl) {
				if (!sent) {
					sent = true;
					ctl.enqueue(new Uint8Array(data.subarray(3 * size, 3 * size + MiB)));
				} else ctl.error(new Error("connection reset"));
			},
		});
		const cut = await rawRequest(
			h,
			"PUT",
			uploads(sb, `/${id}${qs({ offset: 3 * size })}`),
			{
				headers: { "content-type": "application/octet-stream" },
				body: broken,
			},
		);
		expect(cut.status).toBe(400);
		expect(((await cut.json()) as Any).error.code).toBe("validation");
		let at = await offsetOf(id);
		expect(at).toBe(3 * size);
		// A repeat of the 3rd chunk: 409 with the current offset.
		const again = await chunk(id, 2 * size, data.subarray(2 * size, 3 * size));
		expect(again.status).toBe(409);
		expect(err(again)).toMatchObject({
			code: "upload_offset_mismatch",
			details: { offset: 3 * size },
		});
		expect(again.headers.get("sbx-upload-offset")).toBe(String(3 * size));
		while ((at ?? 0) < total) {
			const off = at ?? 0;
			const r = await chunk(id, off, data.subarray(off, off + size));
			expect(r.status).toBe(200);
			at = (r.body as Any).offset;
		}
		expect(await offsetOf(id)).toBe(total);
		const commit = await h.request("POST", uploads(sb, `/${id}/commit`), {
			json: { path: "big/upload.bin", sha256: sha256(data), mode: 0o600 },
		});
		expect(commit.status).toBe(200);
		expect(commit.body).toMatchObject({
			path: "/home/user/big/upload.bin",
			type: "file",
			sizeBytes: total,
			mode: 0o600,
		});
		const home = w.agent.machine(sb.machineId).home;
		expect(sha256(readFileSync(join(home, "big/upload.bin")))).toBe(
			sha256(data),
		);
		// commit is idempotent by upload id.
		const repeat = await h.request("POST", uploads(sb, `/${id}/commit`), {
			json: { path: "big/upload.bin", sha256: sha256(data) },
		});
		expect(repeat.status).toBe(200);
		expect(repeat.body).toEqual(commit.body);
	}, 120_000);

	it("an agent 2xx without an offset is 502 agent_error (bad_response)", async () => {
		const agent = withFiles(w, () => Response.json({}));
		const r = await w
			.harness({ deps: { agent } })
			.request(
				"PUT",
				uploads(sb, `/${await begin("bad.bin")}${qs({ offset: 0 })}`),
				{
					headers: { "content-type": "application/octet-stream" },
					body: Buffer.from("x") as Uint8Array<ArrayBuffer>,
				},
			);
		expect(r.status).toBe(502);
		expect(err(r)).toMatchObject({
			code: "agent_error",
			details: { agentCode: "bad_response" },
		});
	});

	it("a chunk above 8 MiB is 413 payload_too_large", async () => {
		const id = await begin("x.bin");
		const r = await chunk(id, 0, new Uint8Array(8 * MiB + 1));
		expect(r.status).toBe(413);
		expect(err(r).code).toBe("payload_too_large");
		expect(await offsetOf(id)).toBeNull();
		const ok = await chunk(id, 0, new Uint8Array(8 * MiB));
		expect(ok.status).toBe(200);
		expect((ok.body as Any).offset).toBe(8 * MiB);
	});

	it("a wrong first offset is 409 upload_offset_mismatch with offset 0", async () => {
		const id = await begin("y.bin");
		const r = await chunk(id, 5, new Uint8Array(3));
		expect(r.status).toBe(409);
		expect(err(r).details).toEqual({ offset: 0 });
		expect(r.headers.get("sbx-upload-offset")).toBe("0");
	});

	it("commit with a wrong sha256 is 422 checksum_mismatch and drops the upload", async () => {
		const id = await begin("c.bin");
		await chunk(id, 0, Buffer.from("hello"));
		const r = await h.request("POST", uploads(sb, `/${id}/commit`), {
			json: { path: "c.bin", sha256: "0".repeat(64) },
		});
		expect(r.status).toBe(422);
		expect(err(r).code).toBe("checksum_mismatch");
		expect(await offsetOf(id)).toBeNull();
		const home = w.agent.machine(sb.machineId).home;
		expect(existsSync(join(home, "c.bin"))).toBe(false);
	});

	it("DELETE cancels; then the upload is 404 upload_not_found", async () => {
		const id = await begin("d.bin");
		await chunk(id, 0, Buffer.from("abc"));
		const r = await h.request("DELETE", uploads(sb, `/${id}`));
		expect(r.status).toBe(204);
		expect(await offsetOf(id)).toBeNull();
		const again = await h.request("DELETE", uploads(sb, `/${id}`));
		expect(again.status).toBe(404);
		expect(err(again).code).toBe("upload_not_found");
		const commit = await h.request("POST", uploads(sb, `/${id}/commit`), {
			json: { path: "d.bin" },
		});
		expect(commit.status).toBe(404);
		expect(err(commit).code).toBe("upload_not_found");
	});

	it("a malformed upload id is 404 upload_not_found on every route", async () => {
		for (const bad of ["nope", "upl_xyz", "cmd_01jbx2v7d3m6c8q9w0e4r5t6y7"]) {
			const put = await chunk(bad, 0, Buffer.from("x"));
			expect(put.status).toBe(404);
			expect(err(put).code).toBe("upload_not_found");
			const del = await h.request("DELETE", uploads(sb, `/${bad}`));
			expect(err(del).code).toBe("upload_not_found");
			const commit = await h.request("POST", uploads(sb, `/${bad}/commit`), {
				json: { path: "x" },
			});
			expect(err(commit).code).toBe("upload_not_found");
			const head = await rawRequest(h, "HEAD", uploads(sb, `/${bad}`));
			expect(head.status).toBe(404);
		}
	});

	it("an upload of another sandbox of the team is 404 upload_not_found here", async () => {
		const other = await readySandbox(w);
		const id = await begin("o.bin", other);
		expect(
			(await chunk(id, 0, Buffer.from("theirs"), "o.bin", other)).status,
		).toBe(200);
		expect(await offsetOf(id)).toBeNull();
		// Here the id is unknown: a chunk past 0 does not continue theirs.
		const put = await chunk(id, 6, Buffer.from("mine"));
		expect(put.status).toBe(409);
		expect(err(put)).toMatchObject({
			code: "upload_offset_mismatch",
			details: { offset: 0 },
		});
		const commit = await h.request("POST", uploads(sb, `/${id}/commit`), {
			json: { path: "o.bin" },
		});
		expect(commit.status).toBe(404);
		expect(err(commit).code).toBe("upload_not_found");
		const del = await h.request("DELETE", uploads(sb, `/${id}`));
		expect(del.status).toBe(404);
		// Untouched in its own sandbox.
		expect(await offsetOf(id, other)).toBe(6);
	});

	it("another team's sandbox is 404 not_found", async () => {
		const team = randomUUID();
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[team, `t-${team}`],
		);
		const foreign = await readySandbox(w, team);
		const r = await h.request("POST", uploads(foreign), {
			json: { path: "x" },
		});
		expect(r.status).toBe(404);
		expect(err(r).code).toBe("not_found");
	});

	it("without files.upload.v1 the answer is 409 agent_outdated", async () => {
		const s = await readySandbox(w);
		w.agent.machine(s.machineId).capabilities = ["files.v1"];
		const r = await h.request("POST", uploads(s), { json: { path: "x" } });
		expect(r.status).toBe(409);
		expect(err(r).details).toEqual({ capability: "files.upload.v1" });
	});

	it("POST and commit need a JSON body; unknown fields are 400", async () => {
		const plain = await h.request("POST", uploads(), {
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ path: "x" }),
		});
		expect(plain.status).toBe(400);
		expect(err(plain).code).toBe("validation");
		const extra = await h.request("POST", uploads(), {
			json: { path: "x", size: 1 },
		});
		expect(extra.status).toBe(400);
	});

	it("files:read cannot upload", async () => {
		const { secret } = await w.key(["files:read"]);
		const r = await w
			.harness({ bearer: secret })
			.request("POST", uploads(), { json: { path: "x" } });
		expect(r.status).toBe(403);
		expect(err(r).details).toEqual({ requiredScope: "files:write" });
	});
});
