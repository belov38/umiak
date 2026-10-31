// Keycloak Admin REST API of the E2E stack (master realm admin).
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
	const r = await fetch(`${KEYCLOAK}/admin/realms/sbx${path}`, {
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
