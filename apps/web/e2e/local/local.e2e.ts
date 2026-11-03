import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("local dashboard/admin, tokenless CLI create/exec/delete and blocked CIDR", async ({
	page,
	request,
}) => {
	const api = process.env.UMIAK_E2E_PUBLIC_API_URL ?? "http://localhost:18080";
	const services = execFileSync(
		"docker",
		[
			"ps",
			"--filter",
			`label=com.docker.compose.project=${process.env.COMPOSE_PROJECT_NAME ?? "umiak-local-e2e"}`,
			"--format",
			'{{.Label "com.docker.compose.service"}}',
		],
		{ encoding: "utf8" },
	);
	expect(services).not.toMatch(/keycloak|oauth2-proxy/);
	const mcp = await request.post(
		process.env.UMIAK_LOCAL_E2E_MCP_URL ?? "http://localhost:18090/mcp",
		{
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
		},
	);
	expect(mcp.status()).toBe(200);
	expect(mcp.headers()["www-authenticate"]).toBeUndefined();

	expect((await (await request.get(`${api}/v1/meta`)).json()).authMode).toBe(
		"none",
	);
	const noTeamUi = async () => {
		await expect(page.locator("body")).not.toContainText(
			/\bteams?\b|\bmembers?\b|\binvite\b/i,
		);
		await expect(page.getByTestId("team-switcher")).toHaveCount(0);
		const labels = await page
			.locator("[aria-label], [title], [placeholder]")
			.evaluateAll((nodes) =>
				nodes
					.flatMap((node) => [
						node.getAttribute("aria-label"),
						node.getAttribute("title"),
						node.getAttribute("placeholder"),
					])
					.filter(Boolean)
					.join(" "),
			);
		expect(labels).not.toMatch(/\bteams?\b|\bmembers?\b|\binvite\b/i);
	};
	await page.goto("/app");
	await expect(page).toHaveURL(/\/app$/);
	await noTeamUi();
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
	await noTeamUi();
	await expect(page.locator("#install")).toContainText("No sign-in");
	await expect(page.locator(".guide-addresses")).toContainText(api);
	await page.getByRole("button", { name: "Dark", exact: true }).click();
	await expect(page.locator("html")).toHaveClass("dark");
	await page.getByRole("button", { name: "Light", exact: true }).click();
	await page.goto("/app/help");
	await expect(page).toHaveURL(/\/app\/getting-started$/);
	for (const path of ["/admin", "/app/account", "/app/teams/new"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/app\/settings$/);
		await noTeamUi();
	}
	await expect(
		page.getByRole("heading", { name: "SSH keys", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Quota and usage", exact: true }),
	).toBeVisible();
	await page.goto("/app/operator");
	await expect(page).toHaveURL(/\/app$/);
	await noTeamUi();
	const internal = await page
		.getByRole("link", { name: "API keys", exact: true })
		.getAttribute("href");
	expect(internal).toMatch(/\/app\/t\//);
	if (!internal) throw new Error("API keys link missing");
	await page.goto(internal);
	await noTeamUi();
	await expect(
		page.getByRole("form", { name: "New API key", exact: true }),
	).toBeVisible();
	await page.goto(internal.replace(/\/keys$/, "/settings"));
	await expect(page).toHaveURL(/\/app\/settings$/);
	await noTeamUi();
	await page.goto(internal.replace(/\/keys$/, "/environments"));
	await page
		.getByRole("button", { name: "New environment", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await noTeamUi();
	await page.keyboard.press("Escape");
	await page.goto("/app/templates");
	await noTeamUi();
	await expect(
		page.getByRole("heading", { name: "Templates", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId("template-card").first()).toContainText(
		"ready",
	);
	await expect(page.getByTestId("template-card").first()).toContainText(
		"Slot / VMID",
	);
	const visualDir =
		process.env.UMIAK_VISUAL_DIR || test.info().outputPath("round4");
	mkdirSync(visualDir, { recursive: true });
	for (const theme of ["Light", "Dark"]) {
		await page.getByRole("button", { name: theme, exact: true }).click();
		await page.screenshot({
			path: join(visualDir, `templates-${theme.toLowerCase()}.png`),
			fullPage: true,
		});
	}
	await page.goto(internal.replace(/\/keys$/, "/sandboxes/new"));
	await expect(page.getByRole("dialog")).toBeVisible();
	await noTeamUi();
	await expect(
		page.getByRole("combobox", { name: "TTL", exact: true }),
	).toContainText("Platform default (no TTL)");
	await expect(
		page.getByRole("combobox", { name: "Idle stop after", exact: true }),
	).toContainText("Platform default (15 min)");

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
			await request.get(
				process.env.UMIAK_LOCAL_E2E_DENIED_URL ?? "http://localhost:14181/app",
				{
					headers: {
						"x-umiak-client-ip": "127.0.0.1",
						"x-forwarded-for": "127.0.0.1",
					},
				},
			)
		).status(),
	).toBe(403);
});

test("local main pages in light and dark", async ({ page }, info) => {
	// UI-only build metadata; no template build is started by this test.
	await page.route("**/quickstart/setup/build", (route) =>
		route.request().method() === "GET"
			? route.fulfill({ json: { buildJob: null, builds: [] } })
			: route.fallback(),
	);
	await page.route("**/quickstart/setup/media/storages", (route) =>
		route.fulfill({ json: { storages: [] } }),
	);
	const dir = process.env.UMIAK_VISUAL_DIR ?? info.outputPath("local-ui");
	mkdirSync(dir, { recursive: true });
	await page.setViewportSize({ width: 1900, height: 1000 });
	await page.goto("/app");
	const keys = await page
		.getByRole("link", { name: "API keys", exact: true })
		.getAttribute("href");
	if (!keys) throw new Error("Missing API keys navigation");
	const base = keys.replace(/\/keys$/, "");
	for (const [name, path] of [
		["sandboxes", "/app"],
		["settings", "/app/settings"],
		["templates", "/app/templates"],
		["getting-started", "/app/getting-started"],
		["keys", keys],
		["environments", `${base}/environments`],
		["snapshots", `${base}/snapshots`],
		["create", `${base}/sandboxes/new`],
	] as const) {
		await page.goto(path);
		await expect(page.getByRole("heading", { level: 1 }).last()).toBeVisible();
		await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
		if (name === "templates" && process.env.UMIAK_UI_QUICKSTART === "1") {
			await expect(
				page
					.getByTestId("template-card")
					.first()
					.getByRole("button", { name: /Build…|Rebuild…/ }),
			).toHaveAttribute("data-variant", "default");
			for (const label of ["Setup", "Owner sessions"])
				await expect(
					page.getByRole("link", { name: label, exact: true }),
				).toHaveAttribute("data-nav-item", "");
		}

		for (const theme of ["light", "dark"]) {
			await page.evaluate((t) => {
				const name = t === "dark" ? "Dark" : "Light";
				const button = Array.from(
					document.querySelectorAll<HTMLButtonElement>(
						".dashboard-theme button",
					),
				).find((b) => b.textContent?.trim() === name);
				if (!button) throw new Error("Appearance control missing");
				button.click();
			}, theme);
			await page.screenshot({
				path: join(dir, `${name}-${theme}.png`),
				fullPage: true,
				animations: "disabled",
			});
		}
	}
});
