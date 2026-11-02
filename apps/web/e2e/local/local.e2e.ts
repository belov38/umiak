import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("local dashboard/admin, tokenless CLI create/exec/delete and blocked CIDR", async ({
	page,
	request,
}) => {
	const api = "http://localhost:18080";
	expect((await (await request.get(`${api}/v1/meta`)).json()).authMode).toBe(
		"none",
	);
	await page.goto("/app");
	await expect(page).toHaveURL(/\/app/);
	await expect(page.locator("body")).not.toContainText("Sign in");
	await expect(page.getByText("Sign out", { exact: true })).toHaveCount(0);
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/admin/);
	await expect(page.locator("body")).not.toContainText("Sign in");
	const dir = mkdtempSync(join(tmpdir(), "umiak-local-e2e-"));
	const root = resolve(import.meta.dirname, "../../../..");
	const cli = (...args: string[]) =>
		execFileSync("bun", [join(root, "apps/cli/src/main.ts"), ...args], {
			cwd: dir,
			env: {
				...process.env,
				XDG_CONFIG_HOME: dir,
				UMIAK_API_KEY: "",
				UMIAK_API_URL: "",
			},
			encoding: "utf8",
			timeout: 90_000,
		});
	cli("login", "--api-url", api);
	const slug = `local-e2e-${Date.now()}`;
	try {
		cli(
			"create",
			"--slug",
			slug,
			"--template",
			"linux",
			"--size",
			"2gb",
			"--wait",
		);
		expect(cli("exec", slug, "--", "printf", "s15-local-ok")).toContain(
			"s15-local-ok",
		);
	} finally {
		cli("rm", slug, "--yes");
	}
	const config = readFileSync(join(dir, "umiak/config.json"), "utf8");
	expect(config).not.toMatch(/accessToken|refreshToken/);
	expect(
		(
			await request.get("http://localhost:14181/app", {
				headers: {
					"x-umiak-client-ip": "127.0.0.1",
					"x-forwarded-for": "127.0.0.1",
				},
			})
		).status(),
	).toBe(403);
});
