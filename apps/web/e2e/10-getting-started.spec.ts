import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { APP, PUBLIC_API } from "./env.ts";
import { expect, test } from "./fixtures.ts";

test("Getting started uses deployment URLs, copies commands and follows appearance", async ({
	as,
}, testInfo) => {
	const { page, context } = await as("alice");
	await expect(
		page.getByTestId("team-switcher").filter({ visible: true }),
	).toBeVisible();
	await page
		.getByRole("link", { name: "Getting started", exact: true })
		.click();
	await expect(page).toHaveURL(/\/app\/getting-started$/);
	await expect(
		page.getByRole("heading", { name: "Getting started", exact: true }),
	).toBeVisible();
	await expect(page.locator(".guide-addresses")).toContainText(APP);
	await expect(page.locator(".guide-addresses")).toContainText(PUBLIC_API);
	for (const id of [
		"concepts",
		"install",
		"first-sandbox",
		"previews",
		"desktops",
		"agents",
		"sdk",
		"limits",
		"troubleshooting",
	]) {
		await expect(page.locator(`#${id}`)).toBeAttached();
	}
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page
		.getByRole("button", { name: "Copy Create a sandbox", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("umiak create --template linux --wait");
	const dir = process.env.UMIAK_VISUAL_DIR
		? resolve(process.env.UMIAK_VISUAL_DIR)
		: testInfo.outputPath("getting-started");
	await mkdir(dir, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const theme of ["Light", "Dark"]) {
		await page.getByRole("button", { name: theme, exact: true }).click();
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({
			path: `${dir}/getting-started-${theme.toLowerCase()}.png`,
			fullPage: true,
		});
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBe(true);
	await page.goto("/app/help");
	await expect(page).toHaveURL(/\/app\/getting-started$/);
});
