import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AnonymousOCI, ociRedirectAllowed } from "./oci.mjs";

test("anonymous OCI token scope is pull-only and tokens never reach blob redirect hosts", async () => {
	const body = Buffer.from("fixture"),
		digest = createHash("sha256").update(body).digest("hex"),
		calls = [];
	const fetcher = async (url, o) => {
		const u = new URL(url);
		calls.push({ u, headers: o.headers });
		if (u.pathname === "/token") {
			assert.equal(
				u.searchParams.get("scope"),
				"repository:fixture/layer:pull",
			);
			assert.equal(o.headers.Authorization, undefined);
			return Response.json({
				token: "ephemeral-anonymous-token",
				expires_in: 300,
			});
		}
		if (!o.headers.Authorization)
			return new Response("", {
				status: 401,
				headers: {
					"WWW-Authenticate":
						'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:fixture/layer:pull"',
				},
			});
		if (u.hostname === "ghcr.io")
			return new Response("", {
				status: 307,
				headers: {
					Location: `https://pkg-containers.githubusercontent.com/blob?signature=fixture`,
				},
			});
		return new Response(body);
	};
	// Redirect handler's test transport sees only a public blob request.
	const client = new AnonymousOCI({
		registry: "https://ghcr.io",
		repository: "fixture/layer",
		fetcher: async (u, o) => {
			if (new URL(u).hostname === "pkg-containers.githubusercontent.com") {
				calls.push({ u: new URL(u), headers: o.headers });
				return new Response(body);
			}
			return fetcher(u, o);
		},
	});
	assert.deepEqual(await client.blob(digest, body.length), body);
	assert.equal(calls.at(-1).headers.Authorization, undefined);
	for (const host of [
		"https://pkg-containers.githubusercontent.com.evil.test/x",
		"http://pkg-containers.githubusercontent.com/x",
		"https://user:pass@pkg-containers.githubusercontent.com/x",
		"https://127.0.0.1/x",
	])
		assert.equal(ociRedirectAllowed("https://ghcr.io", host), false);
});
test("OCI refuses substituted digests and auth realms outside its configured registry", async () => {
	const c = new AnonymousOCI({
		registry: "https://registry.invalid",
		repository: "fixture/layer",
		fetcher: async () => new Response("wrong"),
	});
	await assert.rejects(c.blob("a".repeat(64), 5), /digest/i);
	const bad = new AnonymousOCI({
		registry: "https://registry.invalid",
		repository: "fixture/layer",
		fetcher: async () =>
			new Response("", {
				status: 401,
				headers: {
					"WWW-Authenticate": 'Bearer realm="https://evil.invalid/token"',
				},
			}),
	});
	await assert.rejects(bad.blob("a".repeat(64), 5), /auth.*origin|realm/i);
});

test("honors bounded registry Retry-After without retrying invalid digests", async () => {
	const waits = [];
	let attempts = 0;
	const client = new AnonymousOCI({
		registry: "https://ghcr.io",
		repository: "fixture/layer",
		wait: async (ms) => waits.push(ms),
		fetcher: async () =>
			++attempts === 1
				? new Response("busy", {
						status: 429,
						headers: { "Retry-After": "12" },
					})
				: new Response("x"),
	});
	const sha = createHash("sha256").update("x").digest("hex");
	assert.equal((await client.blob(sha, 1)).toString(), "x");
	assert.deepEqual(waits, [12000]);
});
