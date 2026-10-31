// S8 §15 E2E: teams and cross-team access. An owner invites by email → the
// invitee signs in and sees the team's sandbox; a member sees no
// management buttons and a direct server action answers `forbidden`;
// another team's URL is the no-access page and its id in a server action
// is `forbidden`; CSRF: a server action and `POST /cms-api/users` with a
// foreign Origin → 403.
import {
	callAction,
	captureAction,
	createSandbox,
	expect,
	personalTeam,
	teamOf,
	test,
} from "./fixtures.ts";

test("owner invites, member sees the sandbox but cannot manage; cross-team and CSRF are refused", async ({
	as,
	state,
}) => {
	const alice = await as("alice");
	const alicePersonal = await personalTeam(alice);
	const name = `shared-${state.run}`;
	await alice.page.goto("/app/teams/new");
	await alice.page.getByRole("textbox", { name: "Team name" }).fill(name);
	await alice.page.getByRole("button", { name: "Create team" }).click();
	await alice.page.waitForURL(
		(u) =>
			/\/app\/t\/team_/.test(u.pathname) && !u.pathname.includes(alicePersonal),
	);
	const shared = teamOf(alice.page);
	const slug = `shared-${state.run}`;
	await createSandbox(alice.page, shared, { slug });

	// Invite bob (not signed in yet: a stub that he claims at sign-in).
	await alice.page.goto(`/app/t/${shared}/settings`);
	await alice.page
		.getByRole("textbox", { name: "Email to invite" })
		.fill(state.users.bob.email);
	const invite = await captureAction(alice.page, () =>
		alice.page.getByRole("button", { name: "Invite" }).click(),
	);
	expect(JSON.parse(invite.body)).toEqual([
		shared,
		state.users.bob.email,
		"member",
	]);
	await expect(
		alice.page.getByText(state.users.bob.email).first(),
	).toBeVisible();

	const bob = await as("bob");
	await bob.page.getByRole("button", { name: /^Team:/ }).click();
	await bob.page.getByRole("menuitem", { name }).click();
	await bob.page.waitForURL(new RegExp(`/app/t/${shared}`));
	await expect(bob.page.getByRole("link", { name: slug })).toBeVisible();

	// A member: no management buttons.
	await bob.page.goto(`/app/t/${shared}/settings`);
	await expect(
		bob.page.getByText(state.users.alice.email).first(),
	).toBeVisible();
	await expect(
		bob.page.getByRole("textbox", { name: "Email to invite" }),
	).toHaveCount(0);
	await expect(bob.page.getByRole("button", { name: "Invite" })).toHaveCount(0);
	await expect(bob.page.getByRole("button", { name: /^Remove/ })).toHaveCount(
		0,
	);
	await bob.page.goto(`/app/t/${shared}/keys`);
	await expect(bob.page.getByRole("heading", { level: 1 })).toBeVisible();
	await expect(bob.page.getByRole("button", { name: "New key" })).toHaveCount(
		0,
	);

	// ...and the server action itself refuses him.
	const asMember = await callAction(bob.request, invite, [
		shared,
		`x-${state.run}@e2e.example.com`,
		"owner",
	]);
	expect(asMember.text).toContain('"forbidden"');

	// Another team: its page is the no-access page, its id is forbidden.
	const r = await bob.page.goto(`/app/t/${alicePersonal}`);
	expect(r?.status()).toBe(403);
	await expect(
		bob.page.getByRole("heading", { name: "No access to this team" }),
	).toBeVisible();
	const foreign = await callAction(bob.request, invite, [
		alicePersonal,
		state.users.bob.email,
		"member",
	]);
	expect(foreign.text).toContain('"forbidden"');
	// Nothing changed in alice's personal team.
	await alice.page.goto(`/app/t/${alicePersonal}/settings`);
	await expect(
		alice.page.getByText(state.users.alice.email).first(),
	).toBeVisible();
	await expect(alice.page.getByText(state.users.bob.email)).toHaveCount(0);

	// CSRF: the owner's own valid action with another Origin.
	const evil = await callAction(
		alice.request,
		invite,
		[shared, `evil-${state.run}@e2e.example.com`, "member"],
		"http://evil.example",
	);
	expect(evil.status).toBe(403);
	const cms = await alice.request.post("/cms-api/users", {
		headers: {
			origin: "http://evil.example",
			"content-type": "application/json",
		},
		data: { email: `evil-${state.run}@e2e.example.com` },
	});
	expect(cms.status()).toBe(403);
	await alice.page.goto(`/app/t/${shared}/settings`);
	await expect(alice.page.getByText(`evil-${state.run}`)).toHaveCount(0);
	await expect(alice.page.getByText(`x-${state.run}`)).toHaveCount(0);
});
