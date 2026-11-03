// Isolated owner-renderer fixture: no Compose, PVE or real credentials.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(process.env.UMIAK_UI_SOURCE ?? "../..");
const load = (name) =>
	import(pathToFileURL(resolve(root, "deploy/compose/quickstart", name)));
const { createQuickstartServer } = await load("server.mjs");
const { OwnerStore, MemoryOwnerRepository } = await load("owner.mjs");
const { renderSetup } = await load("setup-ui.mjs");
test("quickstart appearance, focus and revoke confirmation", async () => {
	const baseline = process.env.UMIAK_UI_BASELINE === "1";
	const dir = resolve(
		process.env.UMIAK_VISUAL_DIR ?? "/tmp/umiak-quickstart-ui",
	);
	await mkdir(dir, { recursive: true });
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	const server = createQuickstartServer({
		store,
		setupHandler: async (req, res) => {
			if (req.url !== "/setup") return false;
			res.setHeader("content-type", "text/html");
			res.end(renderSetup({ steps: {} }, origin));
			return true;
		},
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
	});
	const page = await context.newPage();
	try {
		const capture = async (name, path) => {
			await page.goto(origin + path);
			for (const theme of ["light", "dark"]) {
				await page.emulateMedia({ colorScheme: theme });
				if (!baseline)
					await page
						.getByRole("button", {
							name: theme === "dark" ? "Dark" : "Light",
							exact: true,
						})
						.click();
				else {
					await page.evaluate(
						(t) => localStorage.setItem("umiak-theme", t),
						theme,
					);
					await page.reload();
				}
				await page.evaluate(() => document.fonts.ready);
				await page.setViewportSize({ width: 390, height: 844 });
				await page.screenshot({
					path: `${dir}/${name}-${theme}-390.png`,
					fullPage: true,
				});
				assert.equal(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					true,
				);
				await page.setViewportSize({ width: 1440, height: 1000 });
				await page.screenshot({
					path: `${dir}/${name}-${theme}.png`,
					fullPage: true,
				});
				if (baseline) continue;
				assert.equal(
					await page.evaluate(() =>
						document.documentElement.classList.contains("dark"),
					),
					theme === "dark",
				);
				assert.equal(
					await page.evaluate(() =>
						document.fonts.check('16px "Inter Variable"'),
					),
					true,
				);
				await page.locator("body").click({ position: { x: 1, y: 1 } });
				for (let i = 0; i < 9; i++) {
					await page.keyboard.press("Tab");
					const focus = await page.evaluate(() => {
						const s = getComputedStyle(document.activeElement);
						return {
							tag: document.activeElement.tagName,
							style: s.outlineStyle,
							width: parseFloat(s.outlineWidth),
						};
					});
					if (focus.tag !== "BODY")
						assert.ok(
							focus.style !== "none" && focus.width >= 2,
							JSON.stringify(focus),
						);
				}
				await page.reload();
				assert.equal(
					await page.evaluate(() =>
						document.documentElement.classList.contains("dark"),
					),
					theme === "dark",
				);
			}
		};
		await capture("claim", "/app");
		const token = await store.claim(code);
		await capture("signin", "/owner/pair");
		assert.equal(await page.locator("nav").count(), 0);
		await page.getByLabel("Sign-in code", { exact: true }).fill("WRONG");
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await page.getByText("Sign-in failed.", { exact: false }).waitFor();
		const { printSigninCode } = await load("signin-code.mjs");
		const issued = await printSigninCode(store, () => {});
		await page.getByLabel("Sign-in code", { exact: true }).fill(issued.code);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await page.waitForFunction(() => !document.getElementById("signin"));
		assert.equal(await store.authenticate(token), true);
		await page.goto(`${origin}/owner/sessions`);
		await page
			.getByRole("button", { name: "Sign in another browser", exact: true })
			.click();
		await page.locator("#signin-result code").waitFor();
		const anotherCode = await page.locator("#signin-result code").textContent();
		const second = await browser.newContext();
		try {
			const p = await second.newPage();
			await p.goto(`${origin}/owner/sessions`);
			await p.getByLabel("Sign-in code", { exact: true }).fill(anotherCode);
			await p.getByRole("button", { name: "Sign in", exact: true }).click();
			await p
				.getByRole("heading", { name: "Owner sessions", exact: true })
				.waitFor();
			await page.reload();
			await page
				.getByRole("heading", { name: "Owner sessions", exact: true })
				.waitFor();
		} finally {
			await second.close();
		}
		await context.addCookies([
			{ name: "umiak_owner", value: token, url: origin },
		]);
		const pair = await store.pairStart({
			source: "127.0.0.1",
			userAgent: "UI test CLI",
		});
		await capture("pair-approve", `/owner/pair?id=${pair.id}`);
		await capture("sessions", "/owner/sessions");
		if (!baseline) {
			let confirmed = false;
			page.once("dialog", async (d) => {
				confirmed = true;
				await d.dismiss();
			});
			await page
				.getByRole("button", { name: "Revoke", exact: true })
				.first()
				.click();
			assert.equal(confirmed, true);
			assert.equal(await store.authenticate(token), true);
		}
		await capture("setup", "/setup");
		if (!baseline) {
			await page.setViewportSize({ width: 390, height: 844 });
			await page
				.getByRole("button", { name: "Open navigation", exact: true })
				.click();
			await page.getByRole("button", { name: "Dark", exact: true }).click();
			await page
				.getByRole("button", { name: "Close navigation", exact: true })
				.click();
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				true,
			);
			await page.screenshot({
				path: `${dir}/setup-mobile.png`,
				fullPage: true,
			});
		}
	} finally {
		await context.close();
		await browser.close();
		await new Promise((done) => server.close(done));
	}
});
