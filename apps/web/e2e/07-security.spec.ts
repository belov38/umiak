// S8 §15 "Security" against the real oauth2-proxy: forged
// X-Auth-Request-* before sign-in → the login redirect; after sign-in
// forged groups and email change nothing; web refuses requests without the
// identity header and is reachable from oauth2-proxy only; secret values
// never come back in a response; the web image has no auth-proxy.
import { execFileSync } from "node:child_process";
import { APP } from "./env.ts";
import {
	control,
	createSandbox,
	expect,
	openTab,
	personalTeam,
	test,
} from "./fixtures.ts";

const PROJECT =
	process.env.UMIAK_E2E_PROJECT ??
	process.env.COMPOSE_PROJECT_NAME ??
	"umiak-e2e";

function docker(args: string[]): {
	ok: boolean;
	status: number;
	out: string;
} {
	try {
		return {
			ok: true,
			status: 0,
			out: execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }),
		};
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			ok: false,
			status: err.status ?? -1,
			out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

test("forged identity headers before sign-in: oauth2-proxy sends to the login", async ({
	state,
}) => {
	const forged = {
		"X-Auth-Request-Email": state.users.op.email,
		"X-Auth-Request-User": state.users.op.id,
		"X-Auth-Request-Groups": "umiak-operators",
		"X-Auth-Request-Preferred-Username": "op",
	};
	for (const path of ["/app", "/app/operator", "/admin", "/cms-api/users"]) {
		const r = await fetch(`${APP}${path}`, {
			headers: forged,
			redirect: "manual",
		});
		expect(r.status, path).toBe(302);
		expect(r.headers.get("location"), path).toContain(
			"/realms/umiak/protocol/openid-connect/auth",
		);
	}
	// The api behind oauth2-proxy: no session, no answer from the api.
	const api = await fetch(`${APP}/api/v1/me`, {
		headers: forged,
		redirect: "manual",
	});
	expect([302, 401]).toContain(api.status);
	expect(await api.text()).not.toContain(state.users.op.email);
});

test("forged identity headers after sign-in grant nothing", async ({
	as,
	state,
}) => {
	const alice = await as("alice");
	const team = await personalTeam(alice);
	const forged = {
		"X-Auth-Request-Email": state.users.op.email,
		"X-Auth-Request-User": state.users.op.id,
		"X-Auth-Request-Groups": "umiak-operators",
	};
	await alice.context.setExtraHTTPHeaders(forged);
	const r = await alice.page.goto("/app/operator");
	expect(r?.status()).toBe(403);
	// The proxy refuses /admin before Payload renders its config.
	const adminR = await alice.page.goto("/admin");
	expect(adminR?.status()).toBe(403);
	await expect(
		alice.page.getByRole("heading", { name: "Operators only" }),
	).toBeVisible();
	const meR = await alice.request.get(`/api/v1/me?team=${team}`);
	expect(meR.status()).toBe(200);
	const body = (await meR.json()) as {
		user?: { email?: string; isOperator?: boolean };
	};
	expect(JSON.stringify(body)).toContain(state.users.alice.email);
	expect(JSON.stringify(body)).not.toContain(state.users.op.email);
	expect(
		(
			await alice.request.get(`/api/v1/sandboxes?allTeams=true&team=${team}`)
		).status(),
	).toBe(403);
	await alice.context.setExtraHTTPHeaders({});
});

test("unsafe /cms-api requests with a foreign Origin are 403, also for an operator", async ({
	as,
	state,
}) => {
	const op = await as("op");
	for (const path of [
		"/cms-api/users",
		"/cms-api/teams",
		"/cms-api/templates",
	]) {
		const r = await op.request.post(path, {
			headers: {
				origin: "http://evil.example",
				"content-type": "application/json",
			},
			data: {
				email: `evil-${state.run}@e2e.example.com`,
				name: `evil-${state.run}`,
			},
		});
		expect(r.status(), path).toBe(403);
	}
	// No Origin at all is refused the same way.
	const none = await op.request.fetch("/cms-api/teams", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "" },
		data: { name: `none-${state.run}` },
	});
	expect(none.status()).toBe(403);
});

test("Payload's JWT and preference endpoints are closed (S8 §5.4)", async ({
	as,
	state,
}) => {
	const APP_ORIGIN = new URL(APP).origin;
	// refresh-token would issue a Payload JWT nothing accepts: refused even to
	// an operator with the right Origin.
	const op = await as("op");
	const refresh = await op.request.post("/cms-api/users/refresh-token", {
		headers: { origin: APP_ORIGIN },
	});
	expect(refresh.status()).toBe(403);
	expect(await refresh.text()).not.toMatch(/"(refreshedToken|token)"/);
	// A non-operator reaches no Payload REST at all, preferences included.
	const alice = await as("alice");
	const prefs = await alice.request.post(
		`/cms-api/payload-preferences/e2e-${state.run}`,
		{
			headers: { origin: APP_ORIGIN, "content-type": "application/json" },
			data: { value: { x: 1 } },
		},
	);
	expect(prefs.status()).toBe(403);
	expect(
		(await alice.request.get("/cms-api/payload-preferences")).status(),
	).toBe(403);
});

test("web answers 401 without the identity header and only oauth2-proxy reaches it", () => {
	const direct = docker([
		"exec",
		`${PROJECT}-oauth2-proxy-1`,
		"/bin/busybox",
		"wget",
		"-S",
		"-O",
		"/dev/null",
		"http://web:3000/app",
	]);
	expect(direct.ok).toBe(false);
	expect(direct.out).toMatch(/HTTP\/1\.1 401/);
	// From the umiak network (the backend's container) web does not resolve,
	// while Keycloak on the same network does (the probe itself works).
	const probe = (url: string) =>
		docker([
			"exec",
			`${PROJECT}-e2e-backend-1`,
			"node",
			"-e",
			`fetch(${JSON.stringify(url)}).then(() => process.exit(0), (e) => { console.log(e.cause?.code ?? e.message); process.exit(3); })`,
		]);
	const other = probe("http://web:3000/healthz");
	expect(other.status, other.out).toBe(3);
	expect(other.out).toMatch(/ENOTFOUND|EAI_AGAIN/);
	const control = probe("http://keycloak:8080/realms/umiak");
	expect(control.status, control.out).toBe(0);
});

test("the web image has no dev auth proxy", () => {
	const image = docker([
		"inspect",
		`${PROJECT}-web-1`,
		"--format",
		"{{.Image}}",
	]);
	expect(image.ok, image.out).toBe(true);
	const r = docker([
		"run",
		"--rm",
		"--entrypoint",
		"sh",
		image.out.trim(),
		"-c",
		[
			"find / -xdev \\( -name 'auth-proxy*' -o -path '*/apps/web/dev' -o -path '*/apps/web/e2e' \\) -printf 'BAD:%p\\n' 2>/dev/null",
			"find /app -name server.js -path '*/apps/web/*' -printf 'OK:%p\\n'",
		].join("; "),
	]);
	expect(r.ok, r.out).toBe(true);
	// Positive control: the same search finds the server of the image.
	expect(r.out).toContain("OK:/app/web/apps/web/server.js");
	expect(r.out).not.toContain("BAD:");
});

test("secret values never come back; the guest gets them", async ({
	as,
	audit,
	state,
}) => {
	const alice = await as("alice");
	const team = await personalTeam(alice);
	const secret = `S3cr3t-${state.run}-value`;
	audit.forbid(secret, "sandbox secret value");
	const id = await createSandbox(alice.page, team, {
		slug: `sec-${state.run}`,
		env: { PLAIN: `plain-${state.run}` },
		secrets: { API_TOKEN: secret },
	});
	const env = await openTab(alice.page, "Env");
	await expect(
		env.getByRole("row").filter({ hasText: "API_TOKEN" }),
	).toContainText("•••");
	await expect(env.getByRole("row").filter({ hasText: "PLAIN" })).toContainText(
		`plain-${state.run}`,
	);
	await openTab(alice.page, "Overview");
	await alice.page.reload();
	const guest = await control<{
		env: Record<string, string>;
		secretEnvNames: string[];
	}>("GET", `/machine/${id}`);
	expect(guest.status).toBe(200);
	expect(guest.body.env.PLAIN).toBe(`plain-${state.run}`);
	expect(guest.body.secretEnvNames).toContain("API_TOKEN");
});
