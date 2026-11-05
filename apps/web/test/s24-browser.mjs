// Local acceptance against a populated source-stack upgrade; credentials stay in files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const root = process.argv[2];
if (!root) throw new Error("Pass the private upgrade fixture directory");
const { port } = JSON.parse(readFileSync(`${root}/acceptance.json`, "utf8"));
const cookie = readFileSync(`${root}/cookie`, "utf8");
const [name, value] = cookie.split("=");
const base = `http://localhost:${port}`;
const browser = await chromium.launch({ headless: true });
try {
	const context = await browser.newContext();
	await context.addCookies([
		{
			name,
			value,
			domain: "localhost",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "Strict",
		},
	]);
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const failed = [];
	page.on("response", (r) => {
		if (r.status() >= 400 && !r.url().includes("/api/"))
			failed.push(new URL(r.url()).pathname);
	});
	await page.goto(`${base}/app/settings/templates`);
	await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
	await page.getByLabel("Description", { exact: true }).first().waitFor();
	assert.equal(
		await page.getByLabel("Description", { exact: true }).first().inputValue(),
		"S24 operator edit",
	);
	await page
		.getByLabel("Description", { exact: true })
		.first()
		.fill("S24 browser edit");
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await page.getByText("Settings saved", { exact: true }).waitFor();
	await page.reload();
	assert.equal(
		await page.getByLabel("Description", { exact: true }).first().inputValue(),
		"S24 browser edit",
	);
	await page
		.getByRole("link", { name: "Platform defaults", exact: true })
		.click();
	await page.getByLabel("Burst", { exact: true }).waitFor();
	assert.equal(
		await page.getByLabel("Burst", { exact: true }).inputValue(),
		"",
	);
	await page.getByLabel("Burst", { exact: true }).fill("77");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByText("Settings saved", { exact: true }).waitFor();
	await page.reload();
	assert.equal(
		await page.getByLabel("Burst", { exact: true }).inputValue(),
		"77",
	);
	await page.getByRole("link", { name: "Workspaces", exact: true }).click();
	await page
		.getByLabel("Workspace name", { exact: true })
		.fill("S24 browser workspace");
	await page
		.getByRole("button", { name: "Create workspace", exact: true })
		.click();
	await page
		.getByRole("link", { name: "S24 browser workspace", exact: true })
		.waitFor();
	await page
		.getByRole("link", { name: "S24 browser workspace", exact: true })
		.click();
	await page.waitForURL(/\/app\/t\/team_/);
	await page
		.getByRole("link", { name: "API keys", exact: true })
		.first()
		.click();
	await page.getByRole("heading", { name: "API keys", exact: true }).waitFor();
	assert.equal(
		await page.getByText("S24 pre-upgrade scoped key", { exact: true }).count(),
		0,
	);
	await page.goto(`${base}/app/settings/workspaces`);
	await page.route("**/api/v1/settings/teams/*", (route) =>
		route.request().method() === "PATCH"
			? route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({
						error: { message: "Acceptance save conflict" },
					}),
				})
			: route.continue(),
	);
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await page
		.getByRole("alert")
		.filter({ hasText: "Acceptance save conflict" })
		.waitFor();
	assert.deepEqual(errors, []);
	assert.deepEqual(failed, []);
	console.log(
		"SPA browser acceptance passed: deep link, edits, nullable numeric default, navigation, workspace isolation and failed save",
	);
} finally {
	await browser.close();
}
