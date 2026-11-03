import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareWindowsMedia, validateMediaUrl } from "./setup-iso.mjs";

const sha = "a".repeat(64);
const resolve = async () => [{ address: "93.184.216.34" }];
const head = async () => ({
	ok: true,
	status: 200,
	headers: new Headers({ "content-length": "123" }),
});
test("URL accepts public HTTPS and rejects credentials, private DNS and invalid hash", async () => {
	await validateMediaUrl("https://example.com/windows.iso", sha, {
		resolve,
		head,
	});
	for (const url of [
		"http://example.com/a.iso",
		"https://user:secret@example.com/a.iso",
		"https://127.0.0.1/a.iso",
		"https://[::ffff:127.0.0.1]/a.iso",
	])
		await assert.rejects(validateMediaUrl(url, sha, { resolve, head }));
	await assert.rejects(
		validateMediaUrl("https://example.com/a.iso", "bad", { resolve, head }),
		/SHA256/,
	);
	await assert.rejects(
		validateMediaUrl("https://example.com/a.iso", sha, {
			resolve: async () => [{ address: "10.0.0.1" }],
		}),
		/internal/,
	);
	await validateMediaUrl("https://127.0.0.1/a.iso", sha, {
		allowInternal: true,
	});
});
function fake({
	files = [],
	exitstatus = "OK",
	permission = true,
	proxy,
	log = [{ t: "download progress 100%" }],
} = {}) {
	const posts = [];
	return {
		posts,
		async get(path) {
			if (path === "/cluster/options") return { http_proxy: proxy };
			if (path.endsWith("/storage"))
				return [{ storage: "local", content: "iso,backup", active: 1 }];
			if (path === "/access/permissions")
				return permission
					? {
							"/nodes/pve": { "Sys.AccessNetwork": 1 },
							"/storage/local": { "Datastore.AllocateTemplate": 1 },
						}
					: {};
			if (path.endsWith("/content")) return files;
			if (path.includes("/log")) return log;
			if (path.endsWith("/status")) return { status: "stopped", exitstatus };
			throw Error(path);
		},
		async post(path, body) {
			posts.push({ path, body });
			return "UPID:pve:123";
		},
	};
}
const input = { isoUrl: "https://example.com/windows.iso", isoSha256: sha };
test("native download includes required checksum, task log progress and storage", async () => {
	const api = fake();
	const logs = [];
	const result = await prepareWindowsMedia(api, "pve", input, {
		resolve,
		head,
		progress: async (x) => logs.push(x),
	});
	assert.equal(result.iso, `windows-${sha}.iso`);
	assert.equal(api.posts[0].body["checksum-algorithm"], "sha256");
	assert.equal(api.posts[0].body.content, "iso");
	assert.equal(api.posts[0].body.checksum, sha);
	assert.ok(logs.some((x) => x.includes("100%")));
});
test("checksum mismatch from PVE fails and missing permission never downloads", async () => {
	await assert.rejects(
		prepareWindowsMedia(
			fake({ exitstatus: "checksum mismatch" }),
			"pve",
			input,
			{ resolve, head },
		),
		/checksum mismatch/,
	);
	const api = fake({ permission: false });
	await assert.rejects(
		prepareWindowsMedia(api, "pve", input, { resolve, head }),
		/Sys.AccessNetwork/,
	);
	assert.equal(api.posts.length, 0);
});
test("reuse verifies existing media checksum and never overwrites mismatch", async () => {
	const api = fake({ files: [{ volid: `local:iso/windows-${sha}.iso` }] });
	const result = await prepareWindowsMedia(api, "pve", input, {
		resolve,
		head,
		checksum: async () => sha,
	});
	assert.equal(result.mediaStorage, "local");
	assert.equal(api.posts.length, 0);
	await assert.rejects(
		prepareWindowsMedia(api, "pve", input, {
			resolve,
			head,
			checksum: async () => "b".repeat(64),
		}),
		/checksum mismatch/,
	);
	assert.equal(api.posts.length, 0);
});

test("missing checksum downloads unverified and records actual hash; unverified reuse requires size", async () => {
	const api = fake();
	const logs = [];
	const result = await prepareWindowsMedia(
		api,
		"pve",
		{ isoUrl: input.isoUrl },
		{
			resolve,
			head,
			checksum: async () => sha,
			progress: async (x) => logs.push(x),
		},
	);
	assert.equal(result.mediaVerification, "unverified");
	assert.equal(result.isoSha256, sha);
	assert.ok(logs.includes("Not verified: the ISO will be used as downloaded"));
	assert.equal(api.posts[0].body.checksum, undefined);
	assert.equal(api.posts[0].body["checksum-algorithm"], undefined);
	const reused = fake({
		files: [{ volid: "local:iso/windows.iso", size: 123 }],
	});
	const reusedResult = await prepareWindowsMedia(
		reused,
		"pve",
		{ isoUrl: input.isoUrl },
		{
			resolve,
			checksum: async () => sha,
			head: async () => ({
				ok: true,
				headers: new Headers({ "content-length": "123" }),
			}),
		},
	);
	assert.equal(reusedResult.mediaVerification, "unverified");
	assert.equal(reused.posts.length, 0);
	await assert.rejects(
		prepareWindowsMedia(
			reused,
			"pve",
			{ isoUrl: input.isoUrl },
			{
				resolve,
				head: async () => ({
					ok: true,
					headers: new Headers({ "content-length": "124" }),
				}),
			},
		),
		/size differs/,
	);
});

test("download preflight rejects internal redirect before PVE starts", async () => {
	const api = fake();
	await assert.rejects(
		prepareWindowsMedia(api, "pve", input, {
			resolve,
			head: async () => ({
				ok: false,
				status: 302,
				headers: new Headers({ location: "https://127.0.0.1/private.iso" }),
			}),
		}),
		/internal/,
	);
	assert.equal(api.posts.length, 0);
});

test("IPv6 transition ranges cannot bypass private IPv4 rules", async () => {
	for (const host of ["2002:7f00:1::", "2001:0:1234::"])
		await assert.rejects(validateMediaUrl(`https://[${host}]/a.iso`, sha));
});
for (const target of [
	"https://127.0.0.1/a.iso",
	"http://example.com/a.iso",
	"https://example.com/a.iso",
])
	test(`PVE GET redirect audit: ${target}`, async () => {
		const api = fake({
			log: [
				{ t: `Location: ${target} [following]` },
				{
					t: "Connecting to example.com (example.com)|93.184.216.34|:443... connected.",
				},
			],
		});
		const deleted = [];
		api.delete = async (path) => deleted.push(path);
		const action = prepareWindowsMedia(api, "pve", input, { resolve, head });
		if (target.startsWith("https://example")) {
			await action;
			assert.equal(deleted.length, 0);
		} else {
			await assert.rejects(action, /download.*audit/i);
			assert.equal(deleted.length, 1);
			assert.match(deleted[0], /storage\/local\/content\/local%3Aiso/);
		}
	});
test("PVE connecting address is audited even when DNS preflight is public", async () => {
	const api = fake({
		log: [
			{
				t: "Connecting to example.com (example.com)|10.0.0.1|:443... connected.",
			},
		],
	});
	let deleted = false;
	api.delete = async () => {
		deleted = true;
	};
	await assert.rejects(
		prepareWindowsMedia(api, "pve", input, { resolve, head }),
		/download.*audit/i,
	);
	assert.equal(deleted, true);
});

test("HEAD unavailable remains advisory; GET task log is audited before accepting download", async () => {
	for (const headResult of [
		async () => ({ ok: false, status: 405, headers: new Headers() }),
		async () => {
			throw Error("HEAD unsupported");
		},
	]) {
		const api = fake();
		const result = await prepareWindowsMedia(api, "pve", input, {
			resolve,
			head: headResult,
		});
		assert.equal(result.mediaVerification, "verified");
		assert.equal(api.posts.length, 1);
	}
});

test("only configured PVE proxy connection is exempt from destination audit", async () => {
	const { auditDownloadLog } = await import("./setup-iso.mjs");
	const log = [
		{ t: "Resolving proxy.internal (proxy.internal)... 10.2.3.4" },
		{
			t: "Connecting to proxy.internal (proxy.internal)|10.2.3.4|:3128... connected.",
		},
		{ t: "Proxy request sent, awaiting response... 200 OK" },
	];
	await auditDownloadLog(log, input.isoUrl, {
		resolve,
		proxy: "http://proxy.internal:3128",
	});
	await assert.rejects(
		auditDownloadLog(log, input.isoUrl, { resolve }),
		/internal/,
	);
	await assert.rejects(
		auditDownloadLog(
			[
				...log,
				{
					t: "Connecting to private.example (private.example)|10.0.0.9|:443... connected.",
				},
			],
			input.isoUrl,
			{ resolve, proxy: "http://proxy.internal:3128" },
		),
		/internal/,
	);
	await assert.rejects(
		auditDownloadLog(
			[...log, { t: "Location: https://127.0.0.1/secret.iso [following]" }],
			input.isoUrl,
			{ resolve, proxy: "http://proxy.internal:3128" },
		),
		/internal/,
	);
});

test("native download reads datacenter proxy before auditing wget task", async () => {
	const api = fake({
		proxy: "http://10.2.3.4:3128",
		log: [{ t: "Connecting to 10.2.3.4:3128... connected." }],
	});
	const result = await prepareWindowsMedia(api, "pve", input, {
		resolve,
		head,
	});
	assert.equal(result.isoSha256, sha);
});
