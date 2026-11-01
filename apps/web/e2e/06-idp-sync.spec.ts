// S8 §15 / §20.1 E2E: Keycloak offboarding. A user disabled through the
// Keycloak Admin API → one ctl-idp-sync pass (control listener of the e2e
// backend) → `active: false`, the owners see a notice with the team keys
// they created, the keys keep working; enabled again → active again. An
// empty Keycloak answer (the backend's switch) → the pass aborts
// (`umiak_idp_sync_aborted` 1) and nobody is deactivated.
import {
	attachedPty,
	control,
	createSandbox,
	expect,
	personalTeam,
	type Session,
	teamOf,
	test,
} from "./fixtures.ts";
import { setEnabled } from "./keycloak.ts";
import { me } from "./keys-api.ts";

interface SyncAnswer {
	result: {
		aborted: boolean;
		deactivated: string[];
		reactivated: string[];
		abort?: { reason: string; wouldDeactivate: number; active: number };
	};
	abortedGauge: number;
}

async function payloadUser(op: Session, email: string) {
	const r = await op.request.get(
		`/cms-api/users?where[email][equals]=${encodeURIComponent(email)}&depth=0`,
	);
	expect(r.status()).toBe(200);
	const docs = ((await r.json()) as { docs: Record<string, unknown>[] }).docs;
	expect(docs).toHaveLength(1);
	return docs[0] as { id: string; active: boolean; deactivatedReason?: string };
}

test("disabled in Keycloak → deactivated by ctl-idp-sync, notice, keys keep working; empty answer aborts", async ({
	as,
	audit,
	state,
}) => {
	const { alice: aliceUser, dave: daveUser } = state.users;
	const alice = await as("alice");
	await personalTeam(alice);
	const name = `idp-${state.run}`;
	await alice.page.goto("/app/teams/new");
	await alice.page.getByRole("textbox", { name: "Team name" }).fill(name);
	await alice.page.getByRole("button", { name: "Create team" }).click();
	await alice.page.waitForURL(/\/app\/t\/team_[0-9a-z]+$/);
	await expect(
		alice.page.getByRole("button", { name: `Team: ${name}` }),
	).toBeVisible();
	const team = teamOf(alice.page);
	await alice.page.goto(`/app/t/${team}/settings`);
	await alice.page
		.getByRole("textbox", { name: "Email to invite" })
		.fill(daveUser.email);
	await alice.page
		.getByRole("combobox", { name: "Role of the new member" })
		.click();
	await alice.page.getByRole("option", { name: "owner" }).click();
	await alice.page.getByRole("button", { name: "Invite" }).click();
	await expect(alice.page.getByText(daveUser.email).first()).toBeVisible();

	// dave signs in and creates a team key.
	const dave = await as("dave");
	await dave.page.goto(`/app/t/${team}/keys`);
	const dialog = dave.page.getByRole("form", { name: "New team API key" });
	const keyName = `dave-ci-${state.run}`;
	await dialog.getByRole("textbox", { name: "Key name" }).fill(keyName);
	await dialog.getByRole("button", { name: "Create key" }).click();
	const shown = dave.page.getByTestId("key-secret-dialog");
	const secret = (
		await shown.getByTestId("key-secret").textContent()
	)?.trim() as string;
	await shown.getByRole("button", { name: "I have copied it" }).click();
	audit.forbidKey(secret, Date.now());
	expect(await me(secret)).toBe(200);

	// dave works in a terminal of the team's sandbox.
	await createSandbox(alice.page, team, { slug: `idp-${state.run}` });
	// Close codes of the page's WebSockets (Playwright does not expose them).
	await dave.context.addInitScript(() => {
		const w = window as unknown as { __wsCloses: number[] };
		w.__wsCloses = [];
		window.WebSocket = new Proxy(window.WebSocket, {
			construct(target, args) {
				const ws = Reflect.construct(target, args) as WebSocket;
				ws.addEventListener("close", (e) => w.__wsCloses.push(e.code));
				return ws;
			},
		});
	});
	await dave.page.goto(
		`/app/t/${team}/sandboxes/idp-${state.run}?tab=terminal`,
	);
	const opened = attachedPty(dave.page);
	await dave.page.getByRole("button", { name: "New terminal" }).click();
	const ws = await opened;
	const frames: string[] = [];
	ws.on("framereceived", (f) => frames.push(String(f.payload)));

	const op = await as("op");
	expect((await payloadUser(op, daveUser.email)).active).toBe(true);

	// The operator's api-keys surfaces are audited too (no secret, no
	// secretHash value): the admin list and Payload REST from the page.
	await op.page.goto("/admin/collections/api-keys");
	await expect(op.page.getByText(keyName).first()).toBeVisible();
	const rest = await op.page.evaluate(async () => {
		const r = await fetch("/cms-api/api-keys?depth=1&limit=100");
		return { status: r.status, text: await r.text() };
	});
	expect(rest.status).toBe(200);
	expect(rest.text).toContain(keyName);
	expect(await audit.drain()).toEqual([]);
	expect(
		audit.seen.some(
			(s) => s.url.includes("/cms-api/api-keys") && s.text.includes(keyName),
		),
	).toBe(true);

	// Disabled in Keycloak; one pass.
	await setEnabled(daveUser.id, false);
	const pass = await control<SyncAnswer>("POST", "/idp-sync");
	expect(pass.status).toBe(200);
	expect(pass.body.result.aborted).toBe(false);
	expect(pass.body.abortedGauge).toBe(0);
	const deactivated = await payloadUser(op, daveUser.email);
	expect(deactivated).toMatchObject({
		active: false,
		deactivatedReason: "idp_disabled",
	});
	expect(pass.body.result.deactivated).toContain(deactivated.id);

	// His open PTY ends with `error unauthorized` (then close 4401).
	await expect
		.poll(() => frames.find((f) => f.includes('"type":"error"')))
		.toMatch(/"code":"unauthorized"/);
	await expect
		.poll(() =>
			dave.page.evaluate(
				() => (window as unknown as { __wsCloses: number[] }).__wsCloses,
			),
		)
		.toContain(4401);

	// dave's open browser session is refused at once.
	await dave.page.reload();
	await expect(
		dave.page.getByRole("heading", { name: "Account disabled" }),
	).toBeVisible();

	// The owner sees the notice with dave's key; the key still works.
	await alice.page.goto(`/app/t/${team}/keys`);
	const notice = alice.page
		.getByRole("alert")
		.filter({ hasText: "was deactivated in the identity provider" });
	await expect(notice).toContainText(keyName);
	await expect(notice).toContainText(
		"keep working until an owner revokes them",
	);
	expect(await me(secret)).toBe(200);

	// Enabled again: the next pass reactivates him (the sync deactivated him).
	await setEnabled(daveUser.id, true);
	const back = await control<SyncAnswer>("POST", "/idp-sync");
	expect(back.body.result.reactivated).toContain(deactivated.id);
	expect((await payloadUser(op, daveUser.email)).active).toBe(true);

	// dave leaves the team: his key keeps working, marked for the owners.
	await dave.page.goto(`/app/t/${team}/settings`);
	await dave.page.getByRole("button", { name: "Leave team" }).click();
	await dave.page
		.getByRole("alertdialog")
		.or(dave.page.getByRole("dialog"))
		.getByRole("button", { name: "Leave" })
		.click();
	await dave.page.waitForURL((u) => !u.pathname.includes(team));
	expect(await me(secret)).toBe(200);
	await alice.page.goto(`/app/t/${team}/keys`);
	await expect(
		alice.page
			.getByTestId("key-row")
			.filter({ hasText: keyName })
			.getByTestId("creator-note"),
	).toHaveText("creator left the team");

	// Keycloak answers an empty list: the pass aborts, nobody is deactivated.
	expect((await control("PUT", "/keycloak", { mode: "empty" })).status).toBe(
		200,
	);
	try {
		const empty = await control<SyncAnswer>("POST", "/idp-sync");
		expect(empty.body.result).toMatchObject({
			aborted: true,
			deactivated: [],
			abort: { reason: "mass_deactivation" },
		});
		expect(empty.body.abortedGauge).toBe(1);
		for (const u of [aliceUser, daveUser, state.users.op]) {
			expect((await payloadUser(op, u.email)).active, u.email).toBe(true);
		}
		await alice.page.reload();
		await expect(
			alice.page.getByRole("heading", {
				name: "API keys",
				level: 1,
				exact: true,
			}),
		).toBeVisible();
	} finally {
		await control("PUT", "/keycloak", { mode: "real" });
	}
	const ok = await control<SyncAnswer>("POST", "/idp-sync");
	expect(ok.body.result.aborted).toBe(false);
	expect(ok.body.abortedGauge).toBe(0);
});
