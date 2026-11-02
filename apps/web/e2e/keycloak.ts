// Keycloak Admin REST API of the E2E stack (master realm admin).
import type { Page } from "@playwright/test";
import { KEYCLOAK, KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD } from "./env.ts";

async function adminToken(): Promise<string> {
	const r = await fetch(
		`${KEYCLOAK}/realms/master/protocol/openid-connect/token`,
		{
			method: "POST",
			body: new URLSearchParams({
				grant_type: "password",
				client_id: "admin-cli",
				username: KEYCLOAK_ADMIN,
				password: KEYCLOAK_ADMIN_PASSWORD,
			}),
		},
	);
	if (!r.ok) throw new Error(`keycloak admin token: ${r.status}`);
	return ((await r.json()) as { access_token: string }).access_token;
}

async function admin(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const r = await fetch(`${KEYCLOAK}/admin/realms/umiak${path}`, {
		method,
		headers: {
			authorization: `Bearer ${await adminToken()}`,
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!r.ok) {
		throw new Error(
			`keycloak ${method} ${path}: ${r.status} ${await r.text()}`,
		);
	}
	return r;
}

export interface KcUser {
	username: string;
	email: string;
	password: string;
	/** Keycloak id = `sub` = Payload `idpSubject`. */
	id: string;
	firstName: string;
}

/** A verified, enabled user without required actions; returns its id. */
export async function createUser(o: {
	username: string;
	email: string;
	firstName: string;
	password: string;
	groups?: string[];
}): Promise<KcUser> {
	const r = await admin("POST", "/users", {
		username: o.username,
		email: o.email,
		emailVerified: true,
		enabled: true,
		firstName: o.firstName,
		lastName: "E2e",
		requiredActions: [],
		credentials: [{ type: "password", value: o.password, temporary: false }],
		groups: o.groups ?? [],
	});
	const id = r.headers.get("location")?.split("/").pop();
	if (!id) throw new Error("keycloak: no id of the new user");
	return { ...o, id };
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
	await admin("PUT", `/users/${id}`, { enabled });
}

export async function waitForKeycloak(timeoutMs = 120_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			await adminToken();
			return;
		} catch (e) {
			if (Date.now() > end) throw e;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

export async function setEmail(id: string, email: string): Promise<void> {
	await admin("PUT", `/users/${id}`, {
		email,
		username: email,
		emailVerified: true,
	});
}

export async function deleteUser(id: string): Promise<void> {
	await admin("DELETE", `/users/${id}`);
}

/**
 * `umiak login` as the CLI does it (S7 §7.6): the device grant of the public
 * client `umiak-cli`, approved in `page` (a browser already signed in to
 * Keycloak), then the token endpoint polled at the given interval.
 */
export async function deviceLogin(page: Page): Promise<string> {
	const oidc = `${KEYCLOAK}/realms/umiak/protocol/openid-connect`;
	const start = await fetch(`${oidc}/auth/device`, {
		method: "POST",
		body: new URLSearchParams({ client_id: "umiak-cli", scope: "openid" }),
	});
	if (!start.ok) throw new Error(`device start: ${start.status}`);
	const d = (await start.json()) as {
		device_code: string;
		verification_uri_complete: string;
		interval: number;
	};
	await page.goto(d.verification_uri_complete);
	await page.getByRole("button", { name: "Yes" }).click();
	await page.getByText(/device login successful/i).waitFor();
	const end = Date.now() + 60_000;
	for (;;) {
		const r = await fetch(`${oidc}/token`, {
			method: "POST",
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: "umiak-cli",
				device_code: d.device_code,
			}),
		});
		const body = (await r.json()) as { access_token?: string; error?: string };
		if (body.access_token) return body.access_token;
		if (body.error !== "authorization_pending" && body.error !== "slow_down") {
			throw new Error(`device token: ${r.status} ${body.error}`);
		}
		if (Date.now() > end) throw new Error("device token: timed out");
		await new Promise((res) => setTimeout(res, (d.interval || 5) * 1000));
	}
}
