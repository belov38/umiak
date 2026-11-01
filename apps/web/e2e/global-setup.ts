// Global setup of the E2E run: waits for the stack (apps/web/e2e/run.ts or
// a stack brought up by hand), creates this run's Keycloak users and the
// Payload users that never sign in, and writes them to .state/run.json.
// Names carry a run id, so a reused stack never sees a user twice.
import { mkdirSync, writeFileSync } from "node:fs";
import { APP, CONTROL } from "./env.ts";
import { createUser, type KcUser, waitForKeycloak } from "./keycloak.ts";
import { type RunState, STATE_FILE } from "./state.ts";

async function waitFor(url: string, what: string, timeoutMs = 180_000) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const r = await fetch(url, { redirect: "manual" });
			if (r.status < 500) return;
		} catch {
			// not up yet
		}
		if (Date.now() > end) throw new Error(`${what} (${url}) is not up`);
		await new Promise((r) => setTimeout(r, 1000));
	}
}

export default async function globalSetup(): Promise<void> {
	await waitFor(`${APP}/ping`, "oauth2-proxy");
	await waitFor(`${CONTROL}/healthz`, "e2e backend control");
	await waitForKeycloak();

	const run = Date.now().toString(36);
	const password = `pw-${run}-E2e!`;
	const user = (name: string, groups?: string[]) =>
		createUser({
			username: `${name}-${run}`,
			email: `${name}-${run}@e2e.example.com`,
			firstName: name[0]?.toUpperCase() + name.slice(1),
			password,
			...(groups === undefined ? {} : { groups }),
		});
	const users: Record<string, KcUser> = {
		alice: await user("alice"),
		bob: await user("bob"),
		op: await user("op", ["/umiak-operators"]),
		dave: await user("dave"),
	};
	// Active platform users bound to real Keycloak accounts: with them the
	// empty-Keycloak pass would deactivate more than 5 users (> 20 %), so it
	// aborts (S8 §20.1).
	const fillers: KcUser[] = [];
	for (let i = 1; i <= 5; i++) fillers.push(await user(`filler${i}`));
	const r = await fetch(`${CONTROL}/payload-users`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			users: fillers.map((f) => ({ email: f.email, sub: f.id })),
		}),
	});
	if (!r.ok) throw new Error(`payload users: ${r.status} ${await r.text()}`);

	const state: RunState = { run, users, fillers: fillers.map((f) => f.id) };
	mkdirSync(new URL(".", STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
