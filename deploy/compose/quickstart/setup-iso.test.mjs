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
function fake({ files = [], exitstatus = "OK", permission = true } = {}) {
	const posts = [];
	return {
		posts,
		async get(path) {
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
			if (path.endsWith("/log")) return [{ t: "download progress 100%" }];
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
