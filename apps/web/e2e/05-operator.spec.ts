// S8 §15 E2E: operator rights. A non-operator gets 403 on /app/operator,
// /admin and `GET /v1/sandboxes?allTeams=true`; a team key of an operator
// gives no operator rights. The operator sees another team's sandbox and
// blocks it → routes.lookup answers `blocked`; the owner gets
// `sandbox_blocked` on exec, fork, save snapshot, rename and on publishing a
// port again, and can still read and stop.

import { PUBLIC_API } from "./env.ts";
import {
	apiHeaders,
	control,
	createSandbox,
	expect,
	openTab,
	personalTeam,
	state as stateCell,
	test,
} from "./fixtures.ts";
import { bearer } from "./keys-api.ts";

test("non-operators get 403 on the operator screens and allTeams", async ({
	as,
	audit,
	state,
}) => {
	const alice = await as("alice");
	const op = await as("op");
	const r = await alice.page.goto("/app/operator");
	expect(r?.status()).toBe(403);
	// The proxy refuses /admin before Payload renders its config.
	await alice.page.evaluate(() => localStorage.setItem("umiak-theme", "dark"));
	await alice.page.reload();
	await expect(alice.page.locator("html")).toHaveClass("dark");
	await expect(
		alice.page.getByRole("link", { name: "Umiak", exact: true }),
	).toBeVisible();
	const adminR = await alice.page.goto("/admin");
	expect(adminR?.status()).toBe(403);
	await expect(
		alice.page.getByRole("heading", { name: "Operators only" }),
	).toBeVisible();
	await expect(alice.page.locator("html")).toHaveClass("dark");
	await expect(alice.page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(6, 6, 6)",
	);
	await expect(
		alice.page.getByRole("link", { name: "Umiak", exact: true }),
	).toBeVisible();
	await op.page.goto("/admin");
	await expect(op.page.locator(".umiak-admin-icon")).toBeVisible();
	for (const file of [
		"lockup-inter-light.svg",
		"lockup-inter-dark.svg",
		"mark-square.svg",
	]) {
		const asset = await op.request.get(`/brand/${file}`);
		expect(asset.status()).toBe(200);
		expect(asset.headers()["content-type"]).toContain("image/svg+xml");
	}
	const team = await personalTeam(alice);
	const all = await alice.request.get(
		`/api/v1/sandboxes?allTeams=true&team=${team}`,
	);
	expect(all.status()).toBe(403);
	expect(
		(
			await alice.request.get(`/cms-api/users?team=${team}`, {
				headers: { "umiak-team": team },
			})
		).status(),
	).toBe(403);

	// The operator's own team key: no operator rights on the public API.
	const opTeam = await personalTeam(op);
	await op.page.goto(`/app/t/${opTeam}/keys`);
	const dialog = op.page.getByRole("form", { name: "New team API key" });
	await dialog
		.getByRole("textbox", { name: "Key name" })
		.fill(`op-${state.run}`);
	await dialog.getByRole("radio", { name: /^full/ }).check();
	await dialog.getByRole("button", { name: "Create key" }).click();
	const shown = op.page.getByTestId("key-secret-dialog");
	const secret = (
		await shown.getByTestId("key-secret").textContent()
	)?.trim() as string;
	await shown.getByRole("button", { name: "I have copied it" }).click();
	audit.forbidKey(secret, Date.now());
	const byKey = await fetch(`${PUBLIC_API}/v1/sandboxes?allTeams=true`, {
		headers: bearer(secret),
	});
	expect(byKey.status).toBe(403);
	// The operator's browser session does have them.
	const asOp = await op.request.get(
		`/api/v1/sandboxes?allTeams=true&team=${opTeam}`,
	);
	expect(asOp.status()).toBe(200);
});

test("operator blocks another team's sandbox: route blocked, owner refused writes", async ({
	as,
	state,
}) => {
	const alice = await as("alice");
	const team = await personalTeam(alice);
	const slug = `blk-${state.run}`;
	const id = await createSandbox(alice.page, team, { slug });
	const ports = await openTab(alice.page, "Ports");
	await ports.getByRole("button", { name: "Publish a port…" }).click();
	const pub = alice.page.getByRole("dialog", { name: "Publish a port" });
	await pub.getByRole("textbox", { name: /Port/ }).fill("3000");
	await pub.getByRole("radio", { name: /^sso/ }).check();
	await pub.getByRole("button", { name: "Publish" }).click();
	await expect(
		ports.getByRole("listitem").filter({ hasText: "3000" }),
	).toContainText("access: sso");

	const op = await as("op");
	await op.page.goto("/app/operator");
	await op.page
		.getByRole("textbox", { name: "Search name or slug" })
		.fill(slug);
	const row = op.page.getByTestId("operator-row").filter({ hasText: slug });
	await expect(row).toBeVisible();
	// First the port alone: the owner can neither unpublish nor change it.
	await row.getByRole("button", { name: "Ports" }).click();
	const portItem = op.page.getByRole("listitem").filter({ hasText: /^3000/ });
	await portItem.getByRole("button", { name: "Block…" }).click();
	const portBlock = op.page.getByRole("dialog", {
		name: `Block port 3000 of ${slug}?`,
	});
	await portBlock.getByRole("button", { name: "Block" }).click();
	await expect(
		portItem.getByRole("button", { name: "Unblock…" }),
	).toBeVisible();
	const portRefused = async (method: string) => {
		const r = await alice.request.fetch(`/api/v1/sandboxes/${id}/ports/3000`, {
			method,
			headers: { ...apiHeaders(team), "content-type": "application/json" },
			...(method === "PUT" ? { data: { access: "token" } } : {}),
		});
		expect(r.status(), method).toBe(403);
		expect(
			((await r.json()) as { error: { details?: { reason?: string } } }).error
				.details?.reason,
			method,
		).toBe("port_blocked");
	};
	await portRefused("DELETE");
	await portRefused("PUT");

	await row.getByRole("button", { name: "Block…" }).click();
	const block = op.page.getByRole("dialog", { name: `Block ${slug}?` });
	await block.getByRole("textbox", { name: "Note" }).fill("e2e abuse check");
	await block.getByRole("button", { name: "Block" }).click();
	await expect(row.getByRole("button", { name: "Unblock…" })).toBeVisible();

	const route = await control<{ blocked: boolean; blockReason: string }>(
		"GET",
		`/route/${slug}-3000`,
	);
	expect(route.status).toBe(200);
	expect(route.body).toMatchObject({ blocked: true, blockReason: "operator" });

	// The owner: a lock banner, writes refused by the API.
	await alice.page.reload();
	await expect(
		alice.page
			.getByRole("status")
			.filter({ hasText: "only reading, stop and delete work" }),
	).toBeVisible();
	const h = { ...apiHeaders(team), "content-type": "application/json" };
	const refused = async (method: string, path: string, data?: unknown) => {
		const r = await alice.request.fetch(`/api/v1${path}`, {
			method,
			headers: h,
			...(data === undefined ? {} : { data }),
		});
		expect(r.status(), `${method} ${path}`).toBe(403);
		const body = (await r.json()) as {
			error: { code: string; details?: { reason?: string } };
		};
		expect(body.error.details?.reason, `${method} ${path}`).toBe(
			"sandbox_blocked",
		);
	};
	await refused("POST", `/sandboxes/${id}/commands`, {
		command: "echo no",
		mode: "detached",
	});
	await refused("POST", `/sandboxes/${id}/fork`, {});
	await refused("POST", "/snapshots", {
		sandbox: id,
		name: `snap-${state.run}`,
	});
	await refused("PATCH", `/sandboxes/${id}`, { slug: `${slug}-x` });
	await refused("PUT", `/sandboxes/${id}/ports/3001`, { access: "token" });
	// Reading works; so does stop.
	expect(
		(await alice.request.get(`/api/v1/sandboxes/${id}?team=${team}`)).status(),
	).toBe(200);
	await alice.page.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(stateCell(alice.page)).toHaveText("stopped", {
		timeout: 60_000,
	});
	// Resume of a blocked sandbox is refused too.
	await refused("POST", `/sandboxes/${id}/resume`, {});
	// Delete works.
	const del = await alice.request.delete(`/api/v1/sandboxes/${id}`, {
		headers: { ...apiHeaders(team), "Umiak-Confirm-Delete": id },
	});
	expect(del.status(), await del.text()).toBeLessThan(300);
	await expect
		.poll(async () => {
			const r = await alice.request.get(`/api/v1/sandboxes/${id}?team=${team}`);
			return r.status() === 404
				? "gone"
				: ((await r.json()) as { state: string }).state;
		})
		.toMatch(/^(deleted|gone)$/);
});
