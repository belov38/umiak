// Filesystem calls (S7 §11.1): stat, list with signed cursors, mkdir,
// move, chmod, delete; agent errors map to the §5.5 codes.
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "../src/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
} from "./helpers/commands.ts";
import { filesUrl, qs } from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const err = (r: { body: unknown }) => (r.body as Any).error;

describe.skipIf(skipPg())("files ops", () => {
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

	const url = (
		rest: string,
		q: Record<string, string | number | undefined> = {},
	) => filesUrl(sb.ref, `${rest}${Object.keys(q).length ? qs(q) : ""}`);

	describe("stat", () => {
		it("a file, a symlink with noFollow, a missing path", async () => {
			writeFileSync(join(home, "s.txt"), "12345");
			symlinkSync("s.txt", join(home, "s.link"));
			const f = await h.request("GET", url("/stat", { path: "s.txt" }));
			expect(f.status).toBe(200);
			expect(f.body).toMatchObject({
				path: "/home/user/s.txt",
				name: "s.txt",
				type: "file",
				sizeBytes: 5,
				symlinkTarget: null,
			});
			expect(Date.parse((f.body as Any).modifiedAt)).toBeGreaterThan(0);
			const followed = await h.request("GET", url("/stat", { path: "s.link" }));
			expect((followed.body as Any).type).toBe("file");
			const link = await h.request(
				"GET",
				url("/stat", { path: "s.link", noFollow: "true" }),
			);
			expect(link.body).toMatchObject({
				type: "symlink",
				symlinkTarget: "s.txt",
			});
			const missing = await h.request("GET", url("/stat", { path: "none" }));
			expect(missing.status).toBe(404);
			expect(err(missing).code).toBe("path_not_found");
		});

		it("a path above the root is 400 invalid_path", async () => {
			const r = await h.request("GET", url("/stat", { path: "/../../etc" }));
			expect(r.status).toBe(400);
			expect(err(r).code).toBe("invalid_path");
		});
	});

	describe("list", () => {
		beforeAll(() => {
			mkdirSync(join(home, "l/sub"), { recursive: true });
			for (const n of ["a", "b", "c", "d", ".hidden"]) {
				writeFileSync(join(home, "l", n), n);
			}
			writeFileSync(join(home, "l/sub/deep"), "x");
		});

		it("pages with signed cursors until nextCursor is null", async () => {
			const names: string[] = [];
			let cursor: string | undefined;
			for (let i = 0; i < 10; i++) {
				const r = await h.request(
					"GET",
					url("/list", { path: "l", limit: 2, cursor }),
				);
				expect(r.status).toBe(200);
				const b = r.body as Any;
				expect(b.data.length).toBeLessThanOrEqual(2);
				names.push(...b.data.map((e: Any) => e.name));
				cursor = b.nextCursor ?? undefined;
				if (cursor === undefined) break;
				expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
			}
			expect(names).toEqual([".hidden", "a", "b", "c", "d", "sub"]);
		});

		it("depth and includeHidden", async () => {
			const r = await h.request(
				"GET",
				url("/list", { path: "l", depth: 2, includeHidden: "false" }),
			);
			const paths = (r.body as Any).data.map((e: Any) => e.path);
			expect(paths).toEqual([
				"/home/user/l/a",
				"/home/user/l/b",
				"/home/user/l/c",
				"/home/user/l/d",
				"/home/user/l/sub",
				"/home/user/l/sub/deep",
			]);
			expect((r.body as Any).nextCursor).toBeNull();
		});

		it("a forged cursor or one of another path is 400 invalid_cursor", async () => {
			const forged = await h.request(
				"GET",
				url("/list", { path: "l", cursor: "abc.def" }),
			);
			expect(forged.status).toBe(400);
			expect(err(forged).code).toBe("invalid_cursor");
			// Signed with another key.
			const otherKey = encodeCursor(
				JSON.stringify({ path: "l", token: "/home/user/l/a" }),
				randomBytes(32),
			);
			const wrongKey = await h.request(
				"GET",
				url("/list", { path: "l", cursor: otherKey }),
			);
			expect(err(wrongKey).code).toBe("invalid_cursor");
			const first = await h.request(
				"GET",
				url("/list", { path: "l", limit: 1 }),
			);
			const next = (first.body as Any).nextCursor as string;
			const elsewhere = await h.request(
				"GET",
				url("/list", { path: "l/sub", cursor: next }),
			);
			expect(elsewhere.status).toBe(400);
			expect(err(elsewhere).code).toBe("invalid_cursor");
			// Bound to depth, includeHidden and the sandbox too.
			for (const q of [{ depth: 2 }, { includeHidden: "false" }] as Record<
				string,
				string | number
			>[]) {
				const r = await h.request(
					"GET",
					url("/list", { path: "l", cursor: next, ...q }),
				);
				expect(err(r).code).toBe("invalid_cursor");
			}
			const other = await readySandbox(w);
			mkdirSync(join(w.agent.machine(other.machineId).home, "l"));
			const theirs = await h.request(
				"GET",
				filesUrl(other.ref, `/list${qs({ path: "l", cursor: next })}`),
			);
			expect(err(theirs).code).toBe("invalid_cursor");
		});

		it("a file is 409 not_directory; bad depth is 400", async () => {
			const r = await h.request("GET", url("/list", { path: "l/a" }));
			expect(r.status).toBe(409);
			expect(err(r).code).toBe("not_directory");
			const deep = await h.request(
				"GET",
				url("/list", { path: "l", depth: 9 }),
			);
			expect(deep.status).toBe(400);
			expect(err(deep).code).toBe("validation");
		});
	});

	describe("mkdir, move, chmod, delete", () => {
		it("mkdir: 201 when created, 200 when it existed; parents", async () => {
			const r = await h.request("POST", url("/mkdir"), {
				json: { path: "m1", mode: 0o700 },
			});
			expect(r.status).toBe(201);
			expect(r.body).toMatchObject({
				path: "/home/user/m1",
				type: "dir",
				mode: 0o700,
			});
			const again = await h.request("POST", url("/mkdir"), {
				json: { path: "m1" },
			});
			expect(again.status).toBe(200);
			const noParents = await h.request("POST", url("/mkdir"), {
				json: { path: "m2/a/b" },
			});
			expect(noParents.status).toBe(404);
			expect(err(noParents).code).toBe("path_not_found");
			const parents = await h.request("POST", url("/mkdir"), {
				json: { path: "m2/a/b", parents: true },
			});
			expect(parents.status).toBe(201);
			writeFileSync(join(home, "afile"), "x");
			const onFile = await h.request("POST", url("/mkdir"), {
				json: { path: "afile" },
			});
			expect(onFile.status).toBe(409);
			expect(err(onFile).code).toBe("already_exists");
		});

		it("move: FileInfo of the destination; overwrite=false keeps an existing one", async () => {
			writeFileSync(join(home, "mv-src"), "src");
			writeFileSync(join(home, "mv-dst"), "dst");
			const no = await h.request("POST", url("/move"), {
				json: { from: "mv-src", to: "mv-dst" },
			});
			expect(no.status).toBe(409);
			expect(err(no).code).toBe("already_exists");
			const yes = await h.request("POST", url("/move"), {
				json: { from: "mv-src", to: "mv-dst", overwrite: true },
			});
			expect(yes.status).toBe(200);
			expect(yes.body).toMatchObject({
				path: "/home/user/mv-dst",
				sizeBytes: 3,
			});
			const gone = await h.request("POST", url("/move"), {
				json: { from: "mv-src", to: "x" },
			});
			expect(gone.status).toBe(404);
			expect(err(gone).code).toBe("path_not_found");
		});

		it("chmod sets the mode", async () => {
			writeFileSync(join(home, "ch"), "x");
			const r = await h.request("POST", url("/chmod"), {
				json: { path: "ch", mode: 0o600 },
			});
			expect(r.status).toBe(200);
			expect((r.body as Any).mode).toBe(0o600);
			expect(statSync(join(home, "ch")).mode & 0o777).toBe(0o600);
			const bad = await h.request("POST", url("/chmod"), {
				json: { path: "ch", mode: 0o10000 },
			});
			expect(bad.status).toBe(400);
		});

		it("delete: existed true, then false; a non-empty directory needs recursive", async () => {
			writeFileSync(join(home, "del"), "x");
			const r = await h.request("DELETE", url("", { path: "del" }));
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ existed: true });
			const again = await h.request("DELETE", url("", { path: "del" }));
			expect(again.body).toEqual({ existed: false });
			mkdirSync(join(home, "deldir/x"), { recursive: true });
			const nonEmpty = await h.request("DELETE", url("", { path: "deldir" }));
			expect(nonEmpty.status).toBe(409);
			const rec = await h.request(
				"DELETE",
				url("", { path: "deldir", recursive: "true" }),
			);
			expect(rec.body).toEqual({ existed: true });
		});

		it("JSON bodies need application/json; unknown fields are 400", async () => {
			const plain = await h.request("POST", url("/mkdir"), {
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ path: "x" }),
			});
			expect(plain.status).toBe(400);
			const extra = await h.request("POST", url("/move"), {
				json: { from: "a", to: "b", force: true },
			});
			expect(extra.status).toBe(400);
			expect(err(extra).code).toBe("validation");
		});

		it("proxied: mkdir needs Content-Type application/json", async () => {
			const { h: ph, headers } = w.session();
			const plain = await ph.request("POST", url("/mkdir"), {
				headers: { ...headers, "content-type": "text/plain" },
				body: JSON.stringify({ path: "px" }),
			});
			expect(plain.status).toBe(400);
			const ok = await ph.request("POST", url("/mkdir"), {
				headers,
				json: { path: "px" },
			});
			expect(ok.status).toBe(201);
		});

		it("files:read can stat and list but not change", async () => {
			const { secret } = await w.key(["files:read"]);
			const hr = w.harness({ bearer: secret });
			expect(
				(await hr.request("GET", url("/stat", { path: "~" }))).status,
			).toBe(200);
			for (const [m, p, json] of [
				["POST", url("/mkdir"), { path: "r" }],
				["POST", url("/move"), { from: "a", to: "b" }],
				["POST", url("/chmod"), { path: "a", mode: 0o600 }],
				["DELETE", url("", { path: "a" }), undefined],
			] as const) {
				const r = await hr.request(m, p, json === undefined ? {} : { json });
				expect(r.status, `${m} ${p}`).toBe(403);
			}
		});
	});
});
