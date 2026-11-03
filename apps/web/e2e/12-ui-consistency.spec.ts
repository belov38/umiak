// Rendered contracts complement the dependency-free source policy check.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureSandbox, expect, personalTeam, test } from "./fixtures.ts";

test("UI hierarchy, geometry, contrast and captures in both themes", async ({
	as,
	state,
}, info) => {
	const session = await as("alice");
	const { page } = session;
	const team = await personalTeam(session);
	const base = `/app/t/${team}`;
	const dir = resolve(process.env.UMIAK_VISUAL_DIR ?? info.outputPath("ui"));
	await mkdir(dir, { recursive: true });
	await page.setViewportSize({ width: 1900, height: 1000 });
	await ensureSandbox(session, team, `mobile-${state.run}`);
	const paths = [
		base,
		`${base}/snapshots`,
		`${base}/environments`,
		`${base}/keys`,
		`${base}/settings`,
		"/app/account",
		"/app/teams/new",
		"/app/templates",
		"/app/getting-started",
		`${base}/sandboxes/new`,
		...["overview", "terminal", "commands", "files", "ports", "ssh", "env"].map(
			(tab) => `${base}/sandboxes/mobile-${state.run}?tab=${tab}`,
		),
	];
	for (const [index, path] of paths.entries()) {
		await page.goto(path);
		await expect(page.getByRole("heading", { level: 1 }).last()).toBeVisible();
		await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
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
				path: `${dir}/ui-${index}-${theme}.png`,
				fullPage: true,
				animations: "disabled",
			});
			if (process.env.UMIAK_UI_BASELINE === "1") continue;
			const metrics = await page.evaluate(() => {
				const area = document.querySelector(".dashboard-page");
				const content = document.querySelector(".dashboard-content");
				if (!area || !content) throw new Error("Dashboard frame missing");
				const box = area.getBoundingClientRect();
				const parent = content.getBoundingClientRect();
				const active = document.querySelector(
					'.dashboard-nav [aria-current="page"]',
				);
				const activeColour = active ? getComputedStyle(active).color : null;
				const expectedActiveColour = cssColour("--secondary-foreground");
				function cssColour(name: string) {
					const e = document.createElement("span");
					e.style.color = `var(${name})`;
					document.body.append(e);
					const c = getComputedStyle(e).color;
					e.remove();
					return c;
				}
				const primary = Array.from(
					document.querySelectorAll(
						'[data-slot="button"][data-variant="default"]',
					),
				).filter(
					(e) =>
						e.getBoundingClientRect().width > 0 && !e.hasAttribute("disabled"),
				);
				const corners = Array.from(
					document.querySelectorAll(
						'[data-slot="button"],input:not([type=radio]),select,textarea,[data-slot="panel"],[data-slot="dialog-content"]',
					),
				)
					.filter((e) => e.getBoundingClientRect().width > 0)
					.map((e) => getComputedStyle(e).borderRadius);
				const css = getComputedStyle(document.documentElement);
				return {
					activeColour,
					expectedActiveColour,
					left: box.left - parent.left,
					padding: parseFloat(getComputedStyle(content).paddingLeft),
					width: box.width,
					corners,
					primary: primary.map((e) => getComputedStyle(e).backgroundColor),
					bg: css.getPropertyValue("--background").trim(),
					fg: css.getPropertyValue("--foreground").trim(),
					muted: css.getPropertyValue("--muted-foreground").trim(),
					input: css.getPropertyValue("--input").trim(),
					link: css.getPropertyValue("--link").trim(),
					ring: css.getPropertyValue("--ring").trim(),
				};
			});
			if (metrics.activeColour)
				expect(metrics.activeColour).toBe(metrics.expectedActiveColour);
			expect(Math.abs(metrics.left - metrics.padding)).toBeLessThan(1);
			expect(metrics.width).toBeLessThanOrEqual(1037);
			expect(metrics.corners.filter((r) => r !== "0px")).toEqual([]);
			expect(metrics.primary.every((bg) => bg === "rgb(38, 63, 169)")).toBe(
				true,
			);
			for (const fg of [metrics.fg, metrics.muted, metrics.link])
				expect(contrast(fg, metrics.bg)).toBeGreaterThanOrEqual(4.5);
			for (const fg of [metrics.input, metrics.ring])
				expect(contrast(fg, metrics.bg)).toBeGreaterThanOrEqual(3);
			expect(contrast("#fefefe", "#263fa9")).toBeGreaterThanOrEqual(4.5);
		}
	}
	// Template primary must be present for an operator, not merely blue when present.
	const op = await as("op");
	await op.page.setViewportSize({ width: 1900, height: 1000 });
	for (const path of ["/app/templates", "/app/operator"]) {
		await op.page.goto(path);
		await expect(op.page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(op.page.getByText("Loading…", { exact: true })).toHaveCount(0);
		for (const theme of ["Light", "Dark"]) {
			await op.page.getByRole("button", { name: theme, exact: true }).click();
			await op.page.screenshot({
				path: `${dir}/${path.split("/").at(-1)}-operator-${theme.toLowerCase()}.png`,
				fullPage: true,
				animations: "disabled",
			});
		}
		if (path === "/app/templates" && process.env.UMIAK_UI_BASELINE !== "1")
			await expect(
				op.page
					.getByTestId("template-card")
					.first()
					.getByRole("link", { name: "Build instructions" }),
			).toHaveAttribute("data-variant", "outline");
	}
	if (process.env.UMIAK_UI_BASELINE === "1") return;
	await page.goto("/app/getting-started");
	await session.context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.getByRole("button", { name: /Copy/ }).first().click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Light", exact: true }).click();
	await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
		"data-sonner-theme",
		"light",
	);
	await page.getByRole("button", { name: "Dark", exact: true }).click();
	await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
		"data-sonner-theme",
		"dark",
	);
});

function contrast(a: string, b: string) {
	const lum = (hex: string) => {
		const rgb =
			hex
				.replace("#", "")
				.match(/../g)
				?.map((v) => Number.parseInt(v, 16) / 255) ?? [];
		const c = rgb.map((v) =>
			v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
		);
		return (c[0] ?? 0) * 0.2126 + (c[1] ?? 0) * 0.7152 + (c[2] ?? 0) * 0.0722;
	};
	const x = lum(a),
		y = lum(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("keyboard focus remains visible on every control primitive in both themes", async ({
	as,
}) => {
	const session = await as("alice");
	const team = await personalTeam(session);
	const { page } = session;
	await page.setViewportSize({ width: 1400, height: 1000 });
	for (const theme of ["Light", "Dark"]) {
		const seen = new Set<string>();
		for (const path of [`/app/t/${team}/sandboxes/new`, "/app/account"]) {
			await page.goto(path);
			await page.getByRole("button", { name: theme, exact: true }).click();
			// Return to the start and exercise actual sequential keyboard navigation.
			await page.evaluate(() => {
				(document.activeElement as HTMLElement)?.blur();
				window.scrollTo(0, 0);
			});
			for (let i = 0; i < 90; i++) {
				await page.keyboard.press("Tab");
				const focus = await page.evaluate(() => {
					const el = document.activeElement as HTMLElement;
					const slot =
						el.dataset.navItem !== undefined ? "nav-item" : el.dataset.slot;
					if (
						!slot ||
						![
							"button",
							"input",
							"select-trigger",
							"textarea",
							"native-select",
							"nav-item",
						].includes(slot)
					)
						return null;
					const css = getComputedStyle(el);
					return {
						slot,
						style: css.outlineStyle,
						width: parseFloat(css.outlineWidth),
					};
				});
				if (!focus) continue;
				expect(focus.style, `${theme}: ${focus.slot}`).not.toBe("none");
				expect(focus.width, `${theme}: ${focus.slot}`).toBeGreaterThanOrEqual(
					2,
				);
				seen.add(focus.slot);
			}
		}
		for (const primitive of ["button", "input", "select-trigger", "nav-item"])
			expect(seen.has(primitive), `${theme}: tab reached ${primitive}`).toBe(
				true,
			);
	}
});

test("a sixty-character environment name fits a mobile viewport", async ({
	as,
	state,
}) => {
	const session = await as("alice");
	const team = await personalTeam(session);
	const { page } = session;
	const name = `mobile-${state.run}-`.padEnd(60, "x").slice(0, 60);
	await page.goto(`/app/t/${team}/environments`);
	await page
		.getByRole("button", { name: "New environment", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	const checkbox = dialog.getByRole("checkbox").first();
	await checkbox.uncheck();
	const boundary = await checkbox.evaluate((el) => {
		const css = getComputedStyle(el);
		const token = document.createElement("span");
		token.style.color = "var(--input)";
		document.body.append(token);
		const expected = getComputedStyle(token).color;
		token.remove();
		return {
			border: css.borderColor,
			expected,
			width: parseFloat(css.borderWidth),
		};
	});
	expect(boundary.border).toBe(boundary.expected);
	expect(boundary.width).toBeGreaterThanOrEqual(1);
	await checkbox.check();
	expect(
		await checkbox.evaluate((el) => getComputedStyle(el, "::after").opacity),
	).toBe("1");
	await checkbox.uncheck();
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
});

test("the empty Sandboxes view has one primary action", async ({ as }) => {
	const session = await as("alice");
	const team = await personalTeam(session);
	await session.page.route("**/api/v1/sandboxes?*", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await route.fulfill({ json: { data: [], nextCursor: null } });
	});
	await session.page.goto(`/app/t/${team}`);
	await expect(
		session.page.getByText(
			"Create a VM for your project, then connect your tools.",
		),
	).toBeVisible();
	await expect(
		session.page.locator('main [data-slot="button"][data-variant="default"]'),
	).toHaveCount(1);
});
