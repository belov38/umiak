// S8 §15 E2E, sign-in edge cases and platform policy: an email changed in
// the IdP for the same `sub` updates the user; a user deleted in Keycloak
// becomes `idp_deleted` after a ctl-idp-sync pass; a new IdP account (other
// `sub`) with that taken email is refused (403); ssoPortPolicy any → team
// raises the epoch routes.lookup hands to the gateway (old sso cookies end).
import { APP, PUBLIC_API } from "./env.ts";
import {
	control,
	ensureSandbox,
	expect,
	openTab,
	personalTeam,
	signIn,
	test,
} from "./fixtures.ts";
import { createUser, deleteUser, deviceLogin, setEmail } from "./keycloak.ts";
import { bearer } from "./keys-api.ts";

test("IdP email change, deletion and a reused email", async ({
	as,
	browser,
	state,
}) => {
	const password = `pw-${state.run}-Id!`;
	const eve = await createUser({
		username: `eve-${state.run}@e2e.example.com`,
		email: `eve-${state.run}@e2e.example.com`,
		firstName: "Eve",
		password,
	});
	const ctx1 = await browser.newContext({ baseURL: APP });
	const p1 = await ctx1.newPage();
	await signIn(p1, eve);
	const team = /team_[0-9a-z]+/.exec(p1.url())?.[0];
	const me1 = (await (
		await ctx1.request.get(`/api/v1/me?team=${team}`)
	).json()) as {
		user: { id: string; email: string };
	};
	expect(me1.user.email).toBe(eve.email);
	await ctx1.close();

	// Same sub, new email: the same platform user with the new email.
	const newEmail = `eve-new-${state.run}@e2e.example.com`;
	await setEmail(eve.id, newEmail);
	const ctx2 = await browser.newContext({ baseURL: APP });
	const p2 = await ctx2.newPage();
	await signIn(p2, { ...eve, email: newEmail });
	const me2 = (await (
		await ctx2.request.get(`/api/v1/me?team=${team}`)
	).json()) as {
		user: { id: string; email: string };
	};
	expect(me2.user).toMatchObject({ id: me1.user.id, email: newEmail });
	await ctx2.close();

	// Deleted in Keycloak → idp_deleted after a pass.
	const op = await as("op");
	await deleteUser(eve.id);
	const pass = await control<{ result: { aborted: boolean } }>(
		"POST",
		"/idp-sync",
	);
	expect(pass.body.result.aborted).toBe(false);
	const u = await op.request.get(
		`/cms-api/users?where[email][equals]=${encodeURIComponent(newEmail)}&depth=0`,
	);
	expect(((await u.json()) as { docs: unknown[] }).docs).toEqual([
		expect.objectContaining({
			active: false,
			deactivatedReason: "idp_deleted",
		}),
	]);

	// A new Keycloak account (another sub) with the taken email: 403.
	const again = await createUser({
		username: newEmail,
		email: newEmail,
		firstName: "Eve",
		password,
	});
	expect(again.id).not.toBe(eve.id);
	const ctx3 = await browser.newContext({ baseURL: APP });
	const p3 = await ctx3.newPage();
	await p3.goto("/app");
	await p3.getByRole("textbox", { name: "Email" }).fill(newEmail);
	await p3.getByRole("textbox", { name: "Password" }).fill(password);
	await p3.getByRole("button", { name: "Sign In" }).click();
	await expect(
		p3.getByRole("heading", { name: "Account conflict" }),
	).toBeVisible();
	const r = await p3.goto("/app");
	expect(r?.status()).toBe(403);
	await ctx3.close();
});

test("ssoPortPolicy any → team raises the sso epoch of routes.lookup", async ({
	as,
	state,
}) => {
	const alice = await as("alice");
	const team = await personalTeam(alice);
	const slug = `term-${state.run}`;
	await ensureSandbox(alice, team, slug);
	const ports = await openTab(alice.page, "Ports");
	await ports.getByRole("button", { name: "Publish a port…" }).click();
	const d = alice.page.getByRole("dialog", { name: "Publish a port" });
	await d.getByRole("textbox", { name: /Port/ }).fill("3005");
	await d.getByRole("radio", { name: /^sso/ }).check();
	await d.getByRole("button", { name: "Publish" }).click();
	await expect(
		ports.getByRole("listitem").filter({ hasText: "3005" }),
	).toContainText("access: sso");
	const epoch = async () =>
		(await control<{ authEpoch: number }>("GET", `/route/${slug}-3005`)).body
			.authEpoch;
	const before = await epoch();

	const op = await as("op");
	const setPolicy = async (v: "any" | "team") => {
		await op.page.goto("/admin/globals/platform-defaults");
		const field = op.page.locator("#field-ssoPortPolicy");
		await expect(field).toBeVisible();
		if ((await field.locator(".rs__single-value").textContent()) === v) return;
		await field.locator(".rs__control").click();
		await op.page
			.locator(".rs__option", { hasText: new RegExp(`^${v}$`) })
			.click();
		await op.page.getByRole("button", { name: "Save" }).click();
		await expect(op.page.getByText(/updated successfully/i)).toBeVisible();
	};
	await setPolicy("any");
	const start = await epoch();
	expect(start).toBeGreaterThanOrEqual(before);
	try {
		await setPolicy("team");
		expect(await epoch()).toBe(start + 1);
	} finally {
		await setPolicy("any");
	}
	// Back to any: no new epoch (only a tightening ends cookies).
	expect(await epoch()).toBe(start + 1);
});

test("Keycloak JWT of the CLI: same user as the browser; an operator's JWT has no operator rights", async ({
	as,
	state,
}) => {
	const alice = await as("alice");
	const team = await personalTeam(alice);
	const sandboxId = await ensureSandbox(alice, team, `term-${state.run}`);
	const browserMe = (await (
		await alice.request.get(`/api/v1/me?team=${team}`)
	).json()) as { user: { id: string } };

	// `sbx login`: device grant approved in alice's signed-in browser.
	const aliceJwt = await deviceLogin(alice.page);
	const cliMe = await fetch(`${PUBLIC_API}/v1/me`, {
		headers: bearer(aliceJwt),
	});
	expect(cliMe.status).toBe(200);
	const cli = (await cliMe.json()) as { user: { id: string; email: string } };
	expect(cli.user).toMatchObject({
		id: browserMe.user.id,
		email: state.users.alice.email,
	});

	// The operator signs in to the CLI the same way: no operator rights.
	const op = await as("op");
	const opTeam = await personalTeam(op);
	const opJwt = await deviceLogin(op.page);
	expect(
		(await fetch(`${PUBLIC_API}/v1/me`, { headers: bearer(opJwt) })).status,
	).toBe(200);
	const all = await fetch(`${PUBLIC_API}/v1/sandboxes?allTeams=true`, {
		headers: { ...bearer(opJwt), "Sbx-Team": opTeam },
	});
	expect(all.status).toBe(403);
	const block = await fetch(`${PUBLIC_API}/v1/sandboxes/${sandboxId}/block`, {
		method: "POST",
		headers: {
			...bearer(opJwt),
			"Sbx-Team": team,
			"content-type": "application/json",
		},
		body: JSON.stringify({ reason: "operator" }),
	});
	expect(block.status).toBe(403);
	// The same calls from the operator's browser session are allowed.
	expect(
		(
			await op.request.get(`/api/v1/sandboxes?allTeams=true&team=${opTeam}`)
		).status(),
	).toBe(200);
	const r = await alice.request.get(
		`/api/v1/sandboxes/${sandboxId}?team=${team}`,
	);
	expect(((await r.json()) as { blocked: boolean }).blocked).toBe(false);
});
