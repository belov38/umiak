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
			).toHaveAttribute("data-variant", "default");
	}
	if (process.env.UMIAK_UI_BASELINE === "1") return;
	await page.goto("/app/getting-started");
	await page.getByRole("button", { name: /Copy/ }).first().click();
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
