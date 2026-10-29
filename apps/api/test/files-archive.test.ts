// Directory archives (S7 §11.1): GET streams tar or tar.gz of a directory,
// PUT unpacks a streamed archive; a round trip keeps every file; hostile
// entries are 400 invalid_path and limits 413.
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/testing/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
	sha256,
} from "./helpers/commands.ts";
import {
	bytesOf,
	filesUrl,
	qs,
	rawRequest,
	tarEntry,
	tarOf,
} from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const err = (r: { body: unknown }) => (r.body as Any).error;

/** sha256 of every regular file under dir, by relative path. */
function hashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) out[relative(dir, p)] = sha256(readFileSync(p));
		}
	};
	walk(dir);
	return out;
}

describe.skipIf(skipPg())("files archive", () => {
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
		mkdirSync(join(home, "proj/src/deep"), { recursive: true });
		writeFileSync(join(home, "proj/README.md"), "# proj\n");
		writeFileSync(join(home, "proj/src/main.bin"), randomBytes(300_000));
		writeFileSync(join(home, "proj/src/deep/x.txt"), "x".repeat(10_000));
		writeFileSync(join(home, "proj/.env"), "A=1\n");
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const archive = (q: Record<string, string | undefined>, s = sb) =>
		filesUrl(s.ref, `/archive${qs(q)}`);

	for (const format of ["tar", "tar.gz"] as const) {
		it(`round trip as ${format}: GET then PUT elsewhere, sha256 of files match`, async () => {
			const get = await rawRequest(h, "GET", archive({ path: "proj", format }));
			expect(get.status).toBe(200);
			expect(get.headers.get("content-type")).toBe(
				format === "tar" ? "application/x-tar" : "application/gzip",
			);
			expect(get.headers.get("content-disposition")).toBe(
				`attachment; filename*=UTF-8''proj.${format}`,
			);
			expect(get.headers.get("x-content-type-options")).toBe("nosniff");
			const body = await bytesOf(get);
			// The upload is a stream too.
			const stream = new ReadableStream<Uint8Array>({
				start(ctl) {
					for (let i = 0; i < body.length; i += 65_536) {
						ctl.enqueue(new Uint8Array(body.subarray(i, i + 65_536)));
					}
					ctl.close();
				},
			});
			const dst = `copy-${format}`;
			const put = await rawRequest(h, "PUT", archive({ path: dst, format }), {
				headers: { "content-type": "application/octet-stream" },
				body: stream,
			});
			expect(put.status).toBe(200);
			const result = (await put.json()) as Any;
			expect(result).toEqual({
				path: `/home/user/${dst}`,
				entries: expect.any(Number),
				sizeBytes: 300_000 + 10_000 + 7 + 4,
			});
			expect(result.entries).toBeGreaterThanOrEqual(6);
			expect(hashes(join(home, dst))).toEqual(hashes(join(home, "proj")));
		});
	}

	it("PUT answers ArchiveResult (validated) and accepts a buffered body", async () => {
		const r = await h.request("PUT", archive({ path: "small" }), {
			headers: { "content-type": "application/x-tar" },
			body: tarOf(
				tarEntry("a.txt", "0", "hello"),
				tarEntry("d/", "5", "", "", 0o755),
			),
		});
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			path: "/home/user/small",
			entries: 2,
			sizeBytes: 5,
		});
		expect(readFileSync(join(home, "small/a.txt"), "utf8")).toBe("hello");
		const gz = await h.request(
			"PUT",
			archive({ path: "smallgz", format: "tar.gz" }),
			{
				headers: { "content-type": "application/gzip" },
				body: new Uint8Array(gzipSync(tarOf(tarEntry("b.txt", "0", "bye")))),
			},
		);
		expect(gz.status).toBe(200);
		expect(readFileSync(join(home, "smallgz/b.txt"), "utf8")).toBe("bye");
	});

	it("GET of a file is 409 not_directory; a missing path 404", async () => {
		const r = await h.request("GET", archive({ path: "proj/README.md" }));
		expect(r.status).toBe(409);
		expect(err(r).code).toBe("not_directory");
		const missing = await h.request("GET", archive({ path: "nope" }));
		expect(missing.status).toBe(404);
		expect(err(missing).code).toBe("path_not_found");
	});

	const hostile: [string, Uint8Array<ArrayBuffer>][] = [
		["../", tarOf(tarEntry("../evil", "0", "x"))],
		["an absolute path", tarOf(tarEntry("/tmp/evil", "0", "x"))],
		[
			"a symlink in the archive",
			tarOf(tarEntry("l", "2", "", "/tmp"), tarEntry("l/evil", "0", "x")),
		],
	];
	for (const [name, tar] of hostile) {
		it(`PUT with ${name} is 400 invalid_path, nothing written`, async () => {
			const dst = `hostile-${name.replace(/[^a-z]/g, "")}`;
			const r = await h.request("PUT", archive({ path: dst }), {
				headers: { "content-type": "application/x-tar" },
				body: tar,
			});
			expect(r.status).toBe(400);
			expect(err(r)).toMatchObject({
				code: "invalid_path",
				details: { entriesWritten: 0 },
			});
			expect(readdirSync(join(home, dst))).toEqual([]);
		});
	}

	it("PUT through a symlink already on disk is 400 invalid_path", async () => {
		mkdirSync(join(home, "ondisk"), { recursive: true });
		mkdirSync(join(home, "elsewhere"), { recursive: true });
		symlinkSync("../elsewhere", join(home, "ondisk/link"));
		const r = await h.request("PUT", archive({ path: "ondisk" }), {
			headers: { "content-type": "application/x-tar" },
			body: tarOf(tarEntry("link/evil", "0", "x")),
		});
		expect(r.status).toBe(400);
		expect(err(r).code).toBe("invalid_path");
		expect(readdirSync(join(home, "elsewhere"))).toEqual([]);
	});

	it("limits of the agent are 413 payload_too_large", async () => {
		const agent = new FakeAgent({ archiveMaxEntries: 2 });
		try {
			const hs = w.harness({ deps: { agent } });
			const r = await hs.request("PUT", archive({ path: "many" }), {
				headers: { "content-type": "application/x-tar" },
				body: tarOf(
					tarEntry("a", "0", "1"),
					tarEntry("b", "0", "2"),
					tarEntry("c", "0", "3"),
				),
			});
			expect(r.status).toBe(413);
			expect(err(r).code).toBe("payload_too_large");
		} finally {
			await agent.close();
		}
	});

	it("without files.archive.v1 the answer is 409 agent_outdated", async () => {
		const s = await readySandbox(w);
		w.agent.machine(s.machineId).capabilities = ["files.v1"];
		const r = await h.request("GET", archive({ path: "~" }, s));
		expect(r.status).toBe(409);
		expect(err(r).details).toEqual({ capability: "files.archive.v1" });
	});

	it("files:read can GET but not PUT", async () => {
		const { secret } = await w.key(["files:read"]);
		const hr = w.harness({ bearer: secret });
		const get = await rawRequest(hr, "GET", archive({ path: "proj" }));
		expect(get.status).toBe(200);
		await get.body?.cancel();
		const put = await hr.request("PUT", archive({ path: "x" }), {
			headers: { "content-type": "application/x-tar" },
			body: tarOf(),
		});
		expect(put.status).toBe(403);
	});
});
