// Visual evidence uses only the isolated compose test backend.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ensureSandbox,
	expect,
	openTab,
	personalTeam,
	test,
} from "./fixtures.ts";

test("dashboard navigation, appearance, responsive layout and page captures", async ({
	as,
	state,
}) => {
	const session = await as("alice");
	const { page } = session;
	const team = await personalTeam(session);
	const base = `/app/t/${team}`;
	const dir = resolve("../../research/boat-dashboard/compare/local");
	await mkdir(dir, { recursive: true });
	await page.setViewportSize({ width: 1900, height: 907 });
	const capture = async (name: string) => {
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({
			path: `${dir}/${name}.png`,
			fullPage: true,
			animations: "disabled",
		});
	};
	const nav = page.getByRole("navigation", { name: "Team navigation" });
	await expect(
		nav.getByRole("link", { name: "Sandboxes", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await expect(nav).not.toContainText(
		/Billing|Plans|Alerts|Webhooks|CI on|Agents &/,
	);
	await expect(page.getByTestId("quota-line")).toBeVisible();
	await capture("sandboxes-initial");
	await page.getByRole("button", { name: "Dark", exact: true }).click();
	await expect(page.locator("html")).toHaveClass("dark");
	await page.reload();
	await expect(page.locator("html")).toHaveClass("dark");
	await expect(
		page.getByRole("button", { name: "Dark", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await capture("sandboxes-dark");
	await page.getByRole("button", { name: "Light", exact: true }).click();
	for (const [path, heading] of [
		["snapshots", "Snapshots"],
		["environments", "Environment"],
		["keys", "API keys"],
		["settings", "Team"],
	]) {
		await page.goto(`${base}/${path}`);
		await expect(page.getByRole("heading", { level: 1 })).toContainText(
			heading ?? "",
		);
		await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
		await capture(path ?? "page");
		if (path === "keys" || path === "environments") {
			await page
				.getByRole("button", {
					name: path === "keys" ? "New key" : "New environment",
					exact: true,
				})
				.click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await capture(`${path}-dialog`);
			await page.keyboard.press("Escape");
		}
	}
	await page.goto("/app/account");
	await expect(
		page.getByRole("heading", { name: "Account", exact: true }),
	).toBeVisible();
	await capture("account");
	await page.goto("/app/teams/new");
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await capture("new-team");
	await page.goto(`${base}/sandboxes/new`);
	await expect(
		page.getByRole("button", { name: "Create", exact: true }),
	).toBeEnabled();
	await capture("create");
	await ensureSandbox(session, team, `visual-${state.run}`);
	await capture("sandbox-detail");
	for (const name of ["Terminal", "Commands", "Files", "Ports", "SSH", "Env"]) {
		await openTab(page, name);
		await capture(`sandbox-${name.toLowerCase()}`);
	}
	await page.goto(base);
	await expect(page.getByTestId("sandbox-table")).toBeVisible();
	await capture("sandboxes");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		nav.getByRole("link", { name: "API keys", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await capture("mobile");
});
