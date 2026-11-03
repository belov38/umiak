import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("local dashboard/admin, tokenless CLI create/exec/delete and blocked CIDR", async ({
	page,
	request,
}) => {
	const api = "http://localhost:18080";
	const services = execFileSync(
		"docker",
		[
			"ps",
			"--filter",
			"label=com.docker.compose.project=umiak-local-e2e",
			"--format",
			'{{.Label "com.docker.compose.service"}}',
		],
		{ encoding: "utf8" },
	);
	expect(services).not.toMatch(/keycloak|oauth2-proxy/);
	const mcp = await request.post("http://localhost:18090/mcp", {
		headers: { accept: "application/json, text/event-stream" },
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "s15-e2e", version: "1" },
			},
		},
	});
	expect(mcp.status()).toBe(200);
	expect(mcp.headers()["www-authenticate"]).toBeUndefined();

	expect((await (await request.get(`${api}/v1/meta`)).json()).authMode).toBe(
		"none",
	);
	await page.goto("/app");
	await expect(page).toHaveURL(/\/app/);
	await expect(page.locator("body")).not.toContainText("Sign in");
	await expect(page.getByText("Sign out", { exact: true })).toHaveCount(0);
	await expect(page.getByTestId("sandbox-onboarding")).toBeVisible();
	await page
		.getByRole("link", { name: "Getting started", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Getting started", exact: true }),
	).toBeVisible();
	await expect(page.locator("#install")).toContainText("No sign-in");
	await expect(page.locator(".guide-addresses")).toContainText(api);
	await page.getByRole("button", { name: "Dark", exact: true }).click();
	await expect(page.locator("html")).toHaveClass("dark");
	await page.getByRole("button", { name: "Light", exact: true }).click();
	await page.goto("/app/help");
	await expect(page).toHaveURL(/\/app\/getting-started$/);
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/admin/);
	await expect(page.locator("body")).not.toContainText("Sign in");
	expect(
		(
			await request.get("/app", { headers: { host: "attacker.example:14180" } })
		).status(),
	).toBe(421);
	const dir = mkdtempSync(join(tmpdir(), "umiak-local-e2e-"));
	const root = resolve(import.meta.dirname, "../../../..");
	const cli = (...args: string[]) =>
		execFileSync("bun", [join(root, "apps/cli/src/main.ts"), ...args], {
			cwd: dir,
			env: {
				...process.env,
				XDG_CONFIG_HOME: dir,
				XDG_STATE_HOME: dir,
				UMIAK_API_KEY: "",
				UMIAK_API_URL: "",
			},
			encoding: "utf8",
			timeout: 90_000,
		});
	cli("login", "--api-url", api);
	const stdio = spawn("bun", [join(root, "apps/cli/src/main.ts"), "mcp"], {
		cwd: dir,
		env: {
			...process.env,
			XDG_CONFIG_HOME: dir,
			XDG_STATE_HOME: dir,
			UMIAK_API_KEY: "",
			UMIAK_API_URL: "",
		},
	});
	try {
		const initialized = new Promise<string>((resolve, reject) => {
			let output = "";
			const timer = setTimeout(
				() => reject(new Error("stdio initialize timed out")),
				15000,
			);
			timer.unref();
			stdio.stdout.on("data", (data) => {
				output += data;
				if (output.includes('"id":1')) {
					clearTimeout(timer);
					resolve(output);
				}
			});
			stdio.on("error", reject);
			stdio.on("exit", (code) => {
				if (code) reject(new Error(`stdio MCP exited ${code}`));
			});
		});
		stdio.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "s15", version: "1" },
				},
			})}\n`,
		);
		expect(await initialized).toContain('"serverInfo"');
	} finally {
		stdio.stdin.end();
		stdio.kill();
	}

	const slug = `local-e2e-${Date.now().toString(36)}x`;
	let created = false;
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
		created = true;
		expect(cli("exec", slug, "--", "printf", "s15-local-ok")).toContain(
			"s15-local-ok",
		);
	} finally {
		if (created) cli("rm", slug, "--yes");
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
