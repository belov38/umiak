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
}, testInfo) => {
	const session = await as("alice");
	const { page } = session;
	const team = await personalTeam(session);
	const base = `/app/t/${team}`;
	const dir = process.env.UMIAK_VISUAL_DIR
		? resolve(process.env.UMIAK_VISUAL_DIR)
		: testInfo.outputPath("dashboard");
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
	await session.context.addInitScript(() => {
		document.addEventListener(
			"DOMContentLoaded",
			() => {
				document.documentElement.dataset.initialTheme =
					document.documentElement.className;
			},
			{ once: true },
		);
	});
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute(
		"data-initial-theme",
		"dark",
	);
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
	await session.context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.getByRole("button", { name: "Copy SSH", exact: true }).click();
	await expect(
		page.getByText("SSH command copied", { exact: true }),
	).toBeVisible();
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
	await expect(page.getByTestId("sandbox-creator").first()).toBeVisible();
	await expect(page.getByTestId("sandbox-creator").first()).toContainText(
		"by ",
	);
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
	const appearance = drawer.getByRole("group", { name: "Appearance" });
	expect(
		await appearance.evaluate(
			(el) =>
				Math.max(
					...Array.from(el.children).map(
						(child) => child.getBoundingClientRect().right,
					),
				) - el.getBoundingClientRect().right,
		),
	).toBeLessThanOrEqual(1);
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

test("acceptance regressions: form geometry, environment list and mobile pages", async ({
	as,
	state,
}, testInfo) => {
	const session = await as("alice");
	const { page, request } = session;
	const team = await personalTeam(session);
	const base = `/app/t/${team}`;
	const assertFits = async () => {
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
			)
			.toBeLessThanOrEqual(1);
	};
	for (const width of [1900, 390]) {
		await page.setViewportSize({ width, height: 907 });
		await page.goto(`${base}/sandboxes/new`);
		await expect(
			page.getByRole("button", { name: "Create", exact: true }),
		).toBeEnabled();
		await assertFits();
		const dialog = page.getByRole("dialog");
		expect(
			await dialog.evaluate((e) => e.scrollWidth - e.clientWidth),
		).toBeLessThanOrEqual(1);
		await page
			.getByRole("textbox", { name: "Label 1 value", exact: true })
			.fill("visible-value");
		await page.screenshot({
			path: testInfo.outputPath(`create-${width}.png`),
			fullPage: true,
		});
	}
	await page.goto(`${base}/environments`);
	await page
		.getByRole("button", { name: "New environment", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	const name = `acceptance-${state.run}`;
	await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByTestId("environment").filter({ hasText: name }),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Environment", exact: true }),
	).toContainText(name);
	const seeded = await request.post("/api/v1/environments", {
		headers: apiHeaders(team),
		data: { name: `second-${state.run}` },
	});
	expect(seeded.ok()).toBe(true);
	await page.reload();
	await expect
		.poll(() => page.getByTestId("environment").count())
		.toBeGreaterThanOrEqual(2);
	await expect(
		page.getByTestId("environment").filter({ hasText: `second-${state.run}` }),
	).toBeVisible();
	await ensureSandbox(session, team, `mobile-${state.run}`);
	const detail = `${base}/sandboxes/mobile-${state.run}`;
	const listUrl = (url: URL) => url.pathname === "/api/v1/sandboxes";
	await page.route(listUrl, async (route) => {
		const response = await route.fetch();
		const data = await response.json();
		await route.fulfill({
			response,
			json: {
				...data,
				data: data.data.map((s: Record<string, unknown>) => ({
					...s,
					health: "degraded",
					healthReason: "Acceptance health reason",
					activity: "busy",
				})),
			},
		});
	});
	await page.setViewportSize({ width: 1100, height: 907 });
	await page.goto(base);
	await expect(page.getByTestId("sandbox-card").first()).toContainText(
		"degraded",
	);
	await expect(page.getByTestId("sandbox-card").first()).toContainText(
		"Acceptance health reason",
	);
	await expect(page.getByTestId("sandbox-card").first()).toContainText(
		"Activity: busy",
	);
	await page.unroute(listUrl);
	await page.setViewportSize({ width: 390, height: 907 });
	await page.goto(base);
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("link", { name: "Skip to content" }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("main")).toBeFocused();

	for (const path of [
		detail,
		"/app/account",
		`${base}/keys`,
		`${base}/environments`,
		`${base}/settings`,
		`${base}/sandboxes/new`,
	]) {
		await page.goto(path);
		await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1 }).last()).toBeVisible();
		await assertFits();
		await page.screenshot({
			path: testInfo.outputPath(`mobile-${path.split("/").at(-1)}.png`),
			fullPage: true,
		});
	}
});
