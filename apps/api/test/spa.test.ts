import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	createInternalApp,
	createProxiedApp,
	createPublicApp,
} from "../src/app.ts";
import { makeTestDeps } from "../src/testing/index.ts";

let directory: string;
const deps = makeTestDeps();
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "s24-spa-"));
	await mkdir(join(directory, "assets"));
	await writeFile(
		join(directory, "index.html"),
		"<!doctype html><title>Umiak</title>",
	);
	await writeFile(join(directory, "assets/app-a1.js"), "export {};");
	vi.stubEnv("UMIAK_WEB_ASSETS_DIR", directory);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true });
});
function request(path: string, method = "GET") {
	return createProxiedApp(deps).request(
		path,
		{ method, headers: { host: new URL(deps.settings.apiUrl).host } },
		{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
	);
}
it("serves SPA deep links and static MIME/cache/security headers", async () => {
	const app = await request("/app/settings/templates");
	expect(app.status).toBe(200);
	expect(app.headers.get("content-type")).toContain("text/html");
	expect(app.headers.get("cache-control")).toBe("no-cache");
	expect(app.headers.get("content-security-policy")).toContain(
		"script-src 'self'",
	);
	const asset = await request("/assets/app-a1.js");
	expect(asset.status).toBe(200);
	expect(asset.headers.get("content-type")).toContain("javascript");
	expect(asset.headers.get("cache-control")).toContain("immutable");
	expect(await (await request("/app", "HEAD")).text()).toBe("");
});
it("never returns index for missing assets, API paths, traversal, unknown pages or mutations", async () => {
	for (const path of [
		"/assets/missing.js",
		"/assets/%2e%2e/index.html",
		"/assets/%252e%252e/index.html",
		"/v1/missing",
		"/app/missing-page",
	]) {
		const response = await request(path);
		expect(response.status, path).toBe(404);
		expect(await response.text()).not.toContain("<!doctype");
	}
	expect((await request("/app", "POST")).status).toBeGreaterThanOrEqual(400);
});
it("redirects owner admin links and never mounts static on public/internal listeners", async () => {
	const redirect = await request("/admin/collections/templates");
	expect(redirect.headers.get("location")).toBe("/app/settings/templates");
	for (const app of [createPublicApp(deps), createInternalApp(deps)])
		expect(
			(
				await app.request(
					"/app",
					{ headers: { host: new URL(deps.settings.apiUrl).host } },
					{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
				)
			).status,
		).not.toBe(200);
});
