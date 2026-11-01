// S8 §15 E2E: team API key: create → `GET /v1/me` with it on the public
// listener → revoke → 401; revoking it while a command stream and a PTY are
// open → the stream gets `error unauthorized`, the PTY closes with 4401.
import { ensureSandbox, expect, personalTeam, test } from "./fixtures.ts";
import { CommandStream, me, openKeyPty } from "./keys-api.ts";

test("API key: works on the public API, revoke ends streams and PTYs, then 401", async ({
	as,
	audit,
	state,
}) => {
	const alice = await as("alice");
	const { page } = alice;
	const team = await personalTeam(alice);
	const sandboxId = await ensureSandbox(alice, team, `term-${state.run}`);

	await page.goto(`/app/t/${team}/keys`);
	const dialog = page.getByRole("form", { name: "New team API key" });
	await dialog
		.getByRole("textbox", { name: "Key name" })
		.fill(`ci-${state.run}`);
	await dialog.getByRole("radio", { name: /^full/ }).check();
	await dialog.getByRole("button", { name: "Create key" }).click();
	const shown = page.getByTestId("key-secret-dialog");
	const secret = (await shown.getByTestId("key-secret").textContent())?.trim();
	expect(secret).toMatch(/^umiak_/);
	await shown.getByRole("button", { name: "I have copied it" }).click();
	await expect(shown).toHaveCount(0);
	// Positive control: the audit reads the bodies the dialog came from.
	expect(await audit.drain()).toEqual([]);
	expect(audit.seen.some((s) => s.text.includes(secret as string))).toBe(true);
	audit.forbidKey(secret as string, Date.now());
	await expect(page.getByText(secret as string)).toHaveCount(0);

	expect(await me(secret as string)).toBe(200);

	const stream = new CommandStream(
		secret as string,
		sandboxId,
		"for i in $(seq 1 600); do echo s-$i; sleep 0.2; done",
	);
	await expect
		.poll(() => stream.frames.some((f) => f.type === "started"))
		.toBe(true);
	const pty = await openKeyPty(secret as string, sandboxId);
	await pty.attached;

	const row = page
		.getByTestId("key-row")
		.filter({ hasText: `ci-${state.run}` });
	await row.getByRole("button", { name: "Revoke" }).click();
	await page
		.getByRole("alertdialog")
		.or(page.getByRole("dialog"))
		.getByRole("button", { name: "Revoke" })
		.click();
	await expect(page.getByText(`Revoked ci-${state.run}`)).toBeVisible();

	await expect
		.poll(() => stream.frames.at(-1))
		.toMatchObject({ type: "error", code: "unauthorized" });
	expect(await pty.closed).toBe(4401);
	expect(await me(secret as string)).toBe(401);
});
