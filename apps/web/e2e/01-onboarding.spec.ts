// S8 §15 E2E: a new user signs in → personal team → create → ready →
// terminal: echo, resize, reload and reconnect without losing output.
import {
	attachedPty,
	control,
	createSandbox,
	expect,
	openTab,
	teamOf,
	test,
	xtermText,
} from "./fixtures.ts";

test("new user: personal team, sandbox ready, terminal survives a reload", async ({
	as,
	state,
}) => {
	const { page, user } = await as("alice");
	// JIT: the first sign-in lands in the new personal team.
	const team = teamOf(page);
	await expect(
		page.getByRole("button", { name: `Team: ${user.email}'s team` }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
	const onboarding = page.getByTestId("sandbox-onboarding");
	await expect(onboarding).toBeVisible();
	for (const [name, hash] of [
		["Install the CLI", "install"],
		["Connect an agent", "agents"],
	] as const) {
		await expect(
			onboarding.getByRole("link", { name, exact: true }),
		).toHaveAttribute("href", `/app/getting-started#${hash}`);
	}
	await expect(
		onboarding.getByRole("link", { name: "Create a sandbox", exact: true }),
	).toHaveAttribute("href", `/app/t/${team}/sandboxes/new`);
	await expect(
		onboarding.getByRole("link", { name: "New sandbox", exact: true }),
	).toHaveAttribute("href", `/app/t/${team}/sandboxes/new`);

	await createSandbox(page, team, { slug: `term-${state.run}` });

	const panel = await openTab(page, "Terminal");
	const opened = attachedPty(page);
	await panel.getByRole("button", { name: "New terminal" }).click();
	await expect(panel.getByRole("button", { name: "Detach" })).toBeVisible();
	const ws = await opened;
	const cmd = /\/ptys\/(cmd_[0-9a-z]+)\//.exec(ws.url())?.[1];
	expect(cmd).toBeDefined();

	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.type("echo hi-$((6*7))\n");
	await expect.poll(() => xtermText(page)).toContain("hi-42");

	// Resize: the browser window shrinks, the agent gets the new size.
	const before = (
		await control<{ sizes: { cols: number; rows: number }[] }>(
			"GET",
			`/pty-sizes/${cmd}`,
		)
	).body.sizes.at(-1);
	await page.setViewportSize({ width: 800, height: 600 });
	await expect
		.poll(
			async () =>
				(
					await control<{ sizes: { cols: number; rows: number }[] }>(
						"GET",
						`/pty-sizes/${cmd}`,
					)
				).body.sizes.at(-1)?.cols,
		)
		.toBeLessThan(before?.cols ?? 0);

	// Reload: the open PTY is attached again with its output (tailBytes).
	const again = attachedPty(page);
	await page.reload();
	await again;
	await expect(panel.getByRole("button", { name: "Detach" })).toBeVisible();
	await expect.poll(() => xtermText(page)).toContain("hi-42");
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.type("echo again-$((5+5))\n");
	await expect.poll(() => xtermText(page)).toContain("again-10");
	expect(await xtermText(page)).toContain("hi-42");
});
