import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { layerInventory } from "./layer-inventory.mjs";
import { collectNpmUpstreamNotices } from "./layer-notices.mjs";

async function fixture(t, npm) {
	const directory = await mkdtemp(join(tmpdir(), "umiak-npm-notices-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "licenses"));
	await writeFile(join(directory, "licenses/npm.json"), JSON.stringify(npm));
	return directory;
}

test("npm packages with their own notices are untouched and need no upstream fetch", async (t) => {
	const npm = [
		{
			name: "own-notices",
			version: "1.0.0",
			license: "MIT",
			notices: ["licenses/npm/own-notices/LICENSE"],
		},
	];
	const original = structuredClone(npm);
	const directory = await fixture(t, npm);
	await mkdir(join(directory, "licenses/npm/own-notices"), { recursive: true });
	const path = join(directory, npm[0].notices[0]);
	await writeFile(path, "original package license\n");
	const fetcher = t.mock.method(globalThis, "fetch", async () => {
		throw Error("A package's own notices must not require network access");
	});
	assert.strictEqual(await collectNpmUpstreamNotices(directory, npm), npm);
	assert.deepEqual(npm, original);
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "licenses/npm.json"))),
		original,
	);
	assert.equal(await readFile(path, "utf8"), "original package license\n");
	assert.equal(fetcher.mock.callCount(), 0);
});

test("npm platform versions fall back through exact tags and expose noticeSource in the inventory", async (t) => {
	const npm = [
		{
			name: "@openai/codex",
			version: "0.166.0-linux-x64",
			license: "Apache-2.0",
			repository: {
				type: "git",
				url: "git+https://github.com/openai/codex.git",
			},
			integrity: "sha512-abc",
			url: "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-linux-x64.tgz",
			notices: [],
		},
	];
	const directory = await fixture(t, npm);
	const prefix = "https://raw.githubusercontent.com/openai/codex/";
	const expectedSource = `${prefix}rust-v0.166.0/LICENSE.md`;
	const bytes = Buffer.from(
		"Apache License\r\nVersion 2.0\r\nfixture notice\r\n",
	);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		requests.push(url);
		return url === expectedSource
			? new Response(bytes)
			: new Response(null, { status: 404 });
	});
	const result = await collectNpmUpstreamNotices(directory, npm);
	const files = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
	assert.deepEqual(requests, [
		...["v0.166.0", "0.166.0"].flatMap((tag) =>
			files.map((name) => `${prefix}${tag}/${name}`),
		),
		`${prefix}rust-v0.166.0/LICENSE`,
		expectedSource,
	]);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const path = `licenses/upstream/${sha256}.txt`;
	assert.equal(result[0].version, "0.166.0-linux-x64");
	assert.equal(result[0].noticeSource, expectedSource);
	assert.deepEqual(result[0].notices, [path]);
	assert.deepEqual(await readFile(join(directory, path)), bytes);
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "licenses/npm.json"))),
		result,
	);
	const inventory = layerInventory({
		sourceCommit: "a".repeat(40),
		facts: { packages: {}, tools: {} },
		packages: [],
		npm: result,
		files: [{ path, sha256, sizeBytes: bytes.length }],
		fetches: [],
	});
	assert.equal(inventory.npm[0].noticeSource, expectedSource);
	assert.deepEqual(inventory.npm[0].noticeFiles, [
		{ path, sha256, sizeBytes: bytes.length },
	]);
	assert.equal(
		JSON.parse(JSON.stringify(inventory)).npm[0].noticeSource,
		expectedSource,
	);
});

test("npm notice capture fails when all exact version tags lack a license, without branch fallback", async (t) => {
	const npm = [
		{
			name: "pnpm",
			version: "12.16.1",
			repository: "https://github.com/pnpm/pnpm.git",
			license: "MIT",
			notices: [],
		},
	];
	const original = structuredClone(npm);
	const directory = await fixture(t, npm);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		requests.push(url);
		return new Response(null, { status: 404 });
	});
	await assert.rejects(collectNpmUpstreamNotices(directory, npm), {
		message: "No tagged upstream license for npm package pnpm@12.16.1",
	});
	assert.deepEqual(
		requests,
		["v12.16.1", "12.16.1", "rust-v12.16.1"].flatMap((tag) =>
			["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"].map(
				(name) => `https://raw.githubusercontent.com/pnpm/pnpm/${tag}/${name}`,
			),
		),
	);
	assert.deepEqual(npm, original);
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "licenses/npm.json"))),
		original,
	);
	await assert.rejects(readFile(join(directory, "licenses/upstream")), {
		code: "ENOENT",
	});
});
