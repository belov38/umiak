// S8 §15 E2E on the sandbox page: commands (live output, kill), files
// (chunked upload, download, preview, rename, delete), ports (token once,
// rotate, public while public ports are off).
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_MIB } from "./env.ts";
import {
	control,
	ensureSandbox,
	expect,
	openTab,
	personalTeam,
	test,
	xtermText,
} from "./fixtures.ts";

test("commands: run, live output, kill", async ({ as, state }) => {
	const alice = await as("alice");
	const { page } = alice;
	const team = await personalTeam(alice);
	await ensureSandbox(alice, team, `term-${state.run}`);
	const panel = await openTab(page, "Commands");
	await panel.getByRole("button", { name: "Run command" }).click();
	const dialog = page.getByRole("dialog", { name: "Run command" });
	const cmd = "for i in $(seq 1 600); do echo tick-$i; sleep 0.2; done";
	await dialog.getByRole("textbox", { name: "Command" }).fill(cmd);
	await dialog.getByRole("button", { name: "Run" }).click();
	const row = panel.getByRole("row").filter({ hasText: "tick-$i" });
	await expect(row.getByRole("cell").first()).toHaveText("running");
	// Live: the output view keeps growing while the command runs.
	await expect.poll(() => xtermText(page)).toContain("tick-3");
	await expect.poll(() => xtermText(page)).toContain("tick-8");
	await panel.getByRole("button", { name: "Kill" }).click();
	await expect(row.getByRole("cell").first()).toHaveText("killed");
	const after = await xtermText(page);
	await expect.poll(() => xtermText(page), { timeout: 2000 }).toBe(after);
});

async function sha256(path: string): Promise<string> {
	const h = createHash("sha256");
	for await (const c of createReadStream(path)) h.update(c as Buffer);
	return h.digest("hex");
}

test("files: chunked upload, download, preview, rename, delete", async ({
	as,
	state,
}) => {
	test.setTimeout(600_000);
	const alice = await as("alice");
	const { page } = alice;
	const team = await personalTeam(alice);
	await ensureSandbox(alice, team, `term-${state.run}`);
	const dir = mkdtempSync(join(tmpdir(), "sbx-e2e-"));
	// Over 64 MiB: the dashboard uploads it in resumable chunks.
	const big = join(dir, `big-${UPLOAD_MIB}.bin`);
	const f = await open(big, "w");
	const block = Buffer.alloc(1024 * 1024);
	for (let i = 0; i < UPLOAD_MIB; i++) {
		block.fill(i % 251);
		block.write(`block-${i}`, 0);
		await f.write(block);
	}
	await f.close();
	const text = join(dir, "notes.txt");
	writeFileSync(text, "hello from the e2e preview\nsecond line\n");

	const panel = await openTab(page, "Files");
	const uploads = panel.getByTestId("uploads");
	await panel.locator('input[type="file"]').setInputFiles(big);
	// Progress "x of y" is shown only for the chunked strategy.
	await expect(uploads).toContainText(/ of /);
	await expect(uploads).toContainText("done", { timeout: 540_000 });
	await panel.locator('input[type="file"]').setInputFiles(text);
	const rowOf = (name: string) =>
		panel.getByTestId("file-row").filter({ hasText: name });
	await expect(rowOf(`big-${UPLOAD_MIB}.bin`)).toContainText(
		`${UPLOAD_MIB} MB`,
	);
	await expect(rowOf("notes.txt")).toBeVisible();

	// Download: the same bytes come back.
	const dl = page.waitForEvent("download");
	await rowOf(`big-${UPLOAD_MIB}.bin`)
		.getByRole("link", { name: "Download" })
		.click();
	const saved = join(dir, "downloaded.bin");
	await (await dl).saveAs(saved);
	expect(await sha256(saved)).toBe(await sha256(big));

	// Preview of a small text file.
	await rowOf("notes.txt").getByRole("button", { name: "notes.txt" }).click();
	const preview = page.getByRole("dialog");
	await expect(preview).toContainText("hello from the e2e preview");
	await page.keyboard.press("Escape");

	// Rename, then delete.
	await rowOf("notes.txt").getByRole("button", { name: "Rename" }).click();
	const move = page.getByRole("dialog", { name: /Move or rename notes.txt/ });
	await move.getByRole("textbox").fill("renamed.txt");
	await move.getByRole("button", { name: "Move" }).click();
	await expect(rowOf("renamed.txt")).toBeVisible();
	await expect(rowOf("notes.txt")).toHaveCount(0);
	await rowOf("renamed.txt").getByRole("button", { name: "Delete" }).click();
	await page
		.getByRole("alertdialog")
		.or(page.getByRole("dialog"))
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(rowOf("renamed.txt")).toHaveCount(0);
	await rowOf(`big-${UPLOAD_MIB}.bin`)
		.getByRole("button", { name: "Delete" })
		.click();
	await page
		.getByRole("alertdialog")
		.or(page.getByRole("dialog"))
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(rowOf(`big-${UPLOAD_MIB}.bin`)).toHaveCount(0);
});

test("ports: token shown once, rotate, public while public ports are off", async ({
	as,
	audit,
	state,
}) => {
	const alice = await as("alice");
	const { page } = alice;
	const team = await personalTeam(alice);
	const slug = `term-${state.run}`;
	await ensureSandbox(alice, team, slug);
	const panel = await openTab(page, "Ports");

	const publish = async (port: number, access: RegExp) => {
		await panel.getByRole("button", { name: "Publish a port…" }).click();
		const d = page.getByRole("dialog", { name: "Publish a port" });
		await d.getByRole("textbox", { name: /Port/ }).fill(String(port));
		await d.getByRole("radio", { name: access }).check();
		await d.getByRole("button", { name: "Publish" }).click();
		return d;
	};
	const tokenDialog = page.getByTestId("port-token-dialog");
	/** Reads the token of the open dialog and closes it; forbids it afterwards. */
	const takeToken = async (label: string) => {
		const token = (
			await tokenDialog
				.locator("code")
				.filter({ hasText: /^sbxp_/ })
				.textContent()
		)?.trim();
		expect(token).toMatch(/^sbxp_/);
		await tokenDialog.getByRole("button", { name: "I have copied it" }).click();
		await expect(tokenDialog).toHaveCount(0);
		audit.forbid(token as string, label, Date.now());
		return token as string;
	};

	await publish(3000, /^token/);
	const first = await takeToken("port token after its dialog");
	const item = panel.getByRole("listitem").filter({ hasText: "3000" });
	await expect(item).toContainText("access: token");
	// Shown once: neither the page nor a reload brings it back.
	await expect(page.getByText(first)).toHaveCount(0);
	await page.reload();
	await expect(item).toContainText("access: token");
	await expect(page.getByText(first)).toHaveCount(0);

	await item.getByRole("button", { name: "Rotate token" }).click();
	await page
		.getByRole("alertdialog")
		.or(page.getByRole("dialog"))
		.getByRole("button", { name: "Rotate" })
		.click();
	await expect(tokenDialog).toContainText("New token of port 3000");
	const second = await takeToken("rotated port token after its dialog");
	expect(second).not.toBe(first);

	// A public port while public ports are on; then an operator turns them off.
	await publish(3001, /^public/);
	await expect(
		panel.getByRole("listitem").filter({ hasText: "3001" }),
	).toContainText("access: public");
	expect(
		(await control<{ blocked: boolean }>("GET", `/route/${slug}-3001`)).body
			.blocked,
	).toBe(false);

	const op = await as("op");
	await setPublicPorts(op.page, false);
	try {
		// routes.lookup answers blocked at once (no cache, C7).
		const r = await control<{ blocked: boolean; blockReason: string }>(
			"GET",
			`/route/${slug}-3001`,
		);
		expect(r.body).toMatchObject({
			blocked: true,
			blockReason: "public_disabled",
		});
		// A new public port: a clear error at the form.
		const d = await publish(3002, /^public/);
		await expect(d).toContainText(
			"A platform operator turned public ports off",
		);
		await page.keyboard.press("Escape");
	} finally {
		await setPublicPorts(op.page, true);
	}
});

/** The `publicPortsEnabled` switch of the platform defaults, through /admin. */
async function setPublicPorts(
	page: import("@playwright/test").Page,
	on: boolean,
): Promise<void> {
	await page.goto("/admin/globals/platform-defaults");
	const box = page.getByRole("checkbox", { name: /Public Ports Enabled/i });
	await expect(box).toBeVisible();
	if ((await box.isChecked()) !== on) {
		await box.setChecked(on);
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText(/updated successfully/i)).toBeVisible();
	}
}
