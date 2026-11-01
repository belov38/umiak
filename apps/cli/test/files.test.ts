// File transfer through the real CLI against the api and the FakeAgent
// (S7 §11.1, §14.2): `cp` both ways (small files in one request, > 64 MiB in
// resumable chunks, `-` for stdin and stdout, `-r` through archives), `push`
// (git ls-files in a repository, else the whole directory) and `run --push`.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { type CliWorld, startWorld, until } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("cp, push, run --push", () => {
	let w: CliWorld;
	let home: CliHome;
	let env: Record<string, string>;
	let sb: { id: string; slug: string };
	beforeAll(async () => {
		w = await startWorld();
		sb = await w.readySandbox();
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(() => {
		home = cliHome();
		env = { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: w.secret };
	});
	afterEach(() => home.rm());

	const umiak = (
		args: string[],
		o: { stdin?: string; cwd?: string; timeoutMs?: number } = {},
	) => runCli(args, { env, ...o });
	const remote = async (cmd: string) => {
		const r = await umiak(["exec", sb.id, "--", cmd]);
		expect(r.code, r.stderr).toBe(0);
		return r.stdout;
	};

	it("cp of a small file both ways, into directories, from stdin and to stdout", async () => {
		const src = join(home.dir, "hello.sh");
		writeFileSync(src, "#!/bin/sh\necho hi\n", { mode: 0o755 });
		const up = await umiak(["cp", src, `${sb.slug}:small/`]);
		expect(up.code, up.stderr).toBe(0);
		expect(up.stdout).toBe("");
		expect(await remote("cat small/hello.sh")).toBe("#!/bin/sh\necho hi\n");
		// The mode bits travel with the file.
		expect(
			await remote(
				"stat -c %a small/hello.sh 2>/dev/null || stat -f %Lp small/hello.sh",
			),
		).toBe("755\n");
		// The explicit sandbox became current: `:path` means it.
		const json = await umiak(["cp", "--json", src, ":small/copy.sh"]);
		expect(json.code, json.stderr).toBe(0);
		expect(json.last()).toMatchObject({ name: "copy.sh", type: "file" });

		const dir = join(home.dir, "down");
		mkdirSync(dir);
		const down = await umiak(["cp", `${sb.id}:small/hello.sh`, dir]);
		expect(down.code, down.stderr).toBe(0);
		expect(readFileSync(join(dir, "hello.sh"), "utf8")).toBe(
			"#!/bin/sh\necho hi\n",
		);

		const fromStdin = await umiak(["cp", "-", `${sb.id}:small/stdin.txt`], {
			stdin: "from stdin\n",
		});
		expect(fromStdin.code, fromStdin.stderr).toBe(0);
		const toStdout = await umiak(["cp", `${sb.id}:small/stdin.txt`, "-"]);
		expect(toStdout.code, toStdout.stderr).toBe(0);
		expect(toStdout.stdout).toBe("from stdin\n");
	});

	it("cp of 70 MiB goes in chunks and comes back byte exact", async () => {
		const data = randomBytes(70 * 1024 * 1024);
		const src = join(home.dir, "big.bin");
		writeFileSync(src, data);
		const before = w.requests.length;
		const up = await umiak(["cp", src, `${sb.id}:big/big.bin`], {
			timeoutMs: 120_000,
		});
		expect(up.code, up.stderr).toBe(0);
		const reqs = w.requests.slice(before);
		expect(
			reqs.filter(
				(r) =>
					/^POST .*\/files\/uploads\?/.test(r) ||
					/^POST .*\/files\/uploads$/.test(r),
			),
		).toHaveLength(1);
		// 4 MiB chunks: 18 PUTs, then a commit.
		expect(
			reqs.filter((r) => /^PUT .*\/files\/uploads\/upl_/.test(r)).length,
		).toBe(18);
		expect(
			reqs.some((r) => /\/files\/uploads\/upl_[^/]+\/commit/.test(r)),
		).toBe(true);
		expect(reqs.some((r) => /^PUT .*\/files\/content/.test(r))).toBe(false);

		const out = join(home.dir, "back.bin");
		const down = await umiak(["cp", `${sb.id}:big/big.bin`, out], {
			timeoutMs: 120_000,
		});
		expect(down.code, down.stderr).toBe(0);
		const back = readFileSync(out);
		expect(back.length).toBe(data.length);
		expect(sha256(back)).toBe(sha256(data));
		// To stdout into a reader that leaves early: quiet exit 141, no retries.
		const started = Date.now();
		const head = await runCli(["cp", `${sb.id}:big/big.bin`, "-"], {
			env,
			closeStdoutAfter: 1,
		});
		expect(head.code, head.stderr).toBe(141);
		expect(head.stderr).toBe("");
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 180_000);

	it("cp -r copies directories both ways through archives", async () => {
		const src = join(home.dir, "tree");
		mkdirSync(join(src, "nested", "deep"), { recursive: true });
		writeFileSync(join(src, "a.txt"), "a\n");
		writeFileSync(join(src, ".hidden"), "h\n");
		writeFileSync(join(src, "nested", "deep", "b.bin"), randomBytes(50_000));
		const before = w.requests.length;
		const up = await umiak(["cp", "-r", src, `${sb.id}:copies`]);
		expect(up.code, up.stderr).toBe(0);
		expect(
			w.requests.slice(before).some((r) => /^PUT .*\/files\/archive/.test(r)),
		).toBe(true);
		// `copies` did not exist: it is the copy itself.
		expect(await remote("cat copies/a.txt copies/.hidden")).toBe("a\nh\n");
		// Now it exists: a second copy goes inside it, like cp -r.
		expect((await umiak(["cp", "-r", src, `${sb.id}:copies`])).code).toBe(0);
		expect(await remote("cat copies/tree/a.txt")).toBe("a\n");

		const dest = join(home.dir, "fetched");
		const down = await umiak(["cp", "-r", `${sb.id}:copies`, dest]);
		expect(down.code, down.stderr).toBe(0);
		expect(readFileSync(join(dest, ".hidden"), "utf8")).toBe("h\n");
		expect(sha256(readFileSync(join(dest, "nested", "deep", "b.bin")))).toBe(
			sha256(readFileSync(join(src, "nested", "deep", "b.bin"))),
		);
		expect(readFileSync(join(dest, "tree", "a.txt"), "utf8")).toBe("a\n");
	});

	it("cp argument errors exit 2", async () => {
		const a = join(home.dir, "x");
		writeFileSync(a, "x");
		expect((await umiak(["cp", a, join(home.dir, "y")])).code).toBe(2);
		expect((await umiak(["cp", `${sb.id}:a`, `${sb.id}:b`])).code).toBe(2);
		expect((await umiak(["cp", home.dir, `${sb.id}:d`])).code).toBe(2);
		expect(await remote("mkdir -p adir && echo ok")).toBe("ok\n");
		const dirNoR = await umiak(["cp", `${sb.id}:adir`, home.dir]);
		expect(dirNoR.code).toBe(2);
		expect(dirNoR.stderr).toContain("-r");
		const missing = await umiak(["cp", `${sb.id}:no/such/file`, a]);
		expect(missing.code).toBe(3);
	});

	it("push sends git ls-files of a repository: tracked and untracked, not ignored", async () => {
		const repo = join(home.dir, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
		const git = (...a: string[]) =>
			execFileSync("git", ["-C", repo, ...a], {
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
		git("init", "-q");
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
		writeFileSync(join(repo, "README.md"), "readme\n");
		writeFileSync(join(repo, "src", "main.ts"), "main\n");
		writeFileSync(join(repo, "gone.txt"), "gone\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
		// Untracked and not ignored: pushed. Ignored: not. Deleted: not.
		writeFileSync(join(repo, "new.txt"), "new\n");
		writeFileSync(join(repo, "debug.log"), "log\n");
		writeFileSync(join(repo, "node_modules", "dep", "index.js"), "dep\n");
		execFileSync("rm", [join(repo, "gone.txt")]);

		const r = await umiak(["push", "--json", repo, `${sb.id}:work/repo`]);
		expect(r.code, r.stderr).toBe(0);
		expect(r.last()).toMatchObject({ entries: expect.any(Number) });
		const listing = await remote("cd work/repo && find . -type f | sort");
		expect(listing.split("\n").filter(Boolean)).toEqual([
			"./.gitignore",
			"./README.md",
			"./new.txt",
			"./src/main.ts",
		]);
		// An ignored directory: git lists nothing, so all of it goes (warned).
		const ignored = await umiak([
			"push",
			join(repo, "node_modules"),
			`${sb.id}:work/deps`,
		]);
		expect(ignored.code, ignored.stderr).toBe(0);
		expect(ignored.stderr).toContain("pushing the whole directory");
		expect(await remote("cat work/deps/dep/index.js")).toBe("dep\n");
		// The default dir is the working directory.
		writeFileSync(join(repo, "src", "main.ts"), "changed\n");
		const again = await umiak(["push", `${sb.id}:work/repo`], { cwd: repo });
		expect(again.code, again.stderr).toBe(0);
		expect(await remote("cat work/repo/src/main.ts")).toBe("changed\n");
	});

	it("push of a directory outside git sends all of it", async () => {
		const dir = join(home.dir, "plain");
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "one.txt"), "1\n");
		writeFileSync(join(dir, "sub", "two.log"), "2\n");
		const r = await umiak(["push", dir, `${sb.id}:work/plain`]);
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toBe("");
		expect(await remote("cat work/plain/one.txt work/plain/sub/two.log")).toBe(
			"1\n2\n",
		);
		expect((await umiak(["push", dir, "no-colon"])).code).toBe(2);
		expect(
			(await umiak(["push", join(home.dir, "missing"), `${sb.id}:x`])).code,
		).toBe(2);
	});

	it("run --push uploads the directory to ~/<name> and runs the command there", async () => {
		const dir = join(home.dir, "proj");
		mkdirSync(dir);
		writeFileSync(join(dir, "input.txt"), "pushed input\n");
		const created = w.requests.length;
		const tag = `push-${Date.now()}`;
		const run = runCli(
			[
				"run",
				"--label",
				`run=${tag}`,
				"--push",
				dir,
				"--",
				"cat input.txt; pwd",
			],
			{ env, timeoutMs: 30_000 },
		);
		// The worker's part: mark the new sandbox ready.
		const slug = await until(async () => {
			const res = await w.db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE labels->>'run' = $1",
				[tag],
			);
			return res.rows[0]?.slug;
		});
		await w.markReady(slug);
		const r = await run;
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toMatch(/^pushed input\n.*\/home\/user\/proj\n$/);
		expect(
			w.requests.slice(created).some((x) => /^PUT .*\/files\/archive/.test(x)),
		).toBe(true);
		// A missing directory is checked before anything is created.
		const before = w.requests.length;
		const bad = await umiak([
			"run",
			"--push",
			join(home.dir, "nope"),
			"--",
			"true",
		]);
		expect(bad.code).toBe(2);
		expect(
			w.requests.slice(before).some((x) => x.startsWith("POST /v1/sandboxes")),
		).toBe(false);
		expect(existsSync(dir) && statSync(dir).isDirectory()).toBe(true);
	});
});
