// Visual evidence uses only the isolated compose test backend.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	apiHeaders,
	ensureSandbox,
	expect,
	openTab,
	personalTeam,
	test,
	xtermText,
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
	const capture = async (name: string, target = page) => {
		await target.evaluate(() => document.fonts.ready);
		const metrics = await target.evaluate(() => {
			const props = [
				"font-family",
				"font-size",
				"font-weight",
				"line-height",
				"letter-spacing",
				"padding",
				"gap",
				"border",
				"border-radius",
				"background-color",
				"color",
				"box-shadow",
			];
			return {
				viewport: { width: innerWidth, height: innerHeight },
				components: Array.from(
					document.querySelectorAll(
						".dashboard-page,.dashboard-sidebar,h1,h2,h3,button,input,table,th,td,[data-slot='select-trigger'],[data-slot='dialog-content'],[data-slot='tabs-trigger']",
					),
				)
					.filter((e) => e.getBoundingClientRect().width > 0)
					.map((e) => ({
						tag: e.tagName,
						slot: e.getAttribute("data-slot"),
						name: (e.getAttribute("aria-label") || e.textContent || "")
							.trim()
							.slice(0, 100),
						classes: e.className,
						box: JSON.parse(JSON.stringify(e.getBoundingClientRect())),
						style: Object.fromEntries(
							props.map((p) => [p, getComputedStyle(e).getPropertyValue(p)]),
						),
					})),
			};
		});
		await writeFile(`${dir}/${name}.json`, JSON.stringify(metrics, null, 2));

		await target.screenshot({
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
	const seeded = await session.request.post("/api/v1/environments", {
		headers: apiHeaders(team),
		data: { name: "base", isDefault: true },
	});
	expect(seeded.ok()).toBe(true);

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
		if (path === "environments") {
			await page
				.getByRole("button", {
					name: "New environment",
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
	await capture("sandbox-detail-ready");
	for (const name of ["Terminal", "Commands", "Files", "Ports", "SSH", "Env"]) {
		await openTab(page, name);
		if (name === "Terminal") {
			await page
				.getByRole("button", { name: "New terminal", exact: true })
				.click();
			await page.getByRole("textbox", { name: "Terminal input" }).focus();
			await page.keyboard.type("echo visual-terminal\n");
			await expect.poll(() => xtermText(page)).toContain("visual-terminal");
		}

		await capture(`sandbox-${name.toLowerCase()}`);
	}
	await openTab(page, "Overview");
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(page.getByTestId("sandbox-state")).toHaveText("stopped", {
		timeout: 90000,
	});
	await expect(
		page.getByText(`Stopping visual-${state.run}`, { exact: true }),
	).toHaveCount(0);
	await capture("sandbox-detail");

	// The compose test stack has no TURN service. Use only a test response
	// override to inspect the existing stopped Desktop frame; no production mock.
	const desktopRef = (url: URL) =>
		url.pathname === `/api/v1/sandboxes/visual-${state.run}` &&
		!url.searchParams.has("waitSeconds");
	await page.route(desktopRef, async (route) => {
		const response = await route.fetch();
		await route.fulfill({
			response,
			json: { ...(await response.json()), template: "linux-desktop" },
		});
	});
	await page.goto(`${base}/sandboxes/visual-${state.run}?tab=desktop`);
	await expect(page.getByRole("tabpanel", { name: "Desktop" })).toContainText(
		"must be ready",
	);
	await capture("sandbox-desktop-stopped");
	await page.unroute(desktopRef);

	await page.goto(base);
	await expect(page.getByTestId("sandbox-table")).toBeVisible();
	await capture("sandboxes");
	await page.setViewportSize({ width: 800, height: 600 });
	await capture("tablet");
	await page.setViewportSize({ width: 390, height: 844 });
	await capture("mobile-closed");
	await page
		.getByRole("button", { name: "Open navigation", exact: true })
		.click();
	await expect(
		nav.getByRole("link", { name: "API keys", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await capture("mobile");
	const drawer = page.getByRole("dialog", { name: "Dashboard navigation" });
	await drawer.getByRole("button", { name: "Dark", exact: true }).click();
	await drawer.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.locator("html")).toHaveClass("dark");
	await page
		.getByRole("button", { name: "Open navigation", exact: true })
		.click();
	await expect(
		drawer.getByRole("button", { name: "Dark", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await drawer.getByRole("button", { name: "Light", exact: true }).click();
	await drawer.getByRole("link", { name: "Snapshots", exact: true }).click();
	await expect(drawer).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Snapshots");
});
