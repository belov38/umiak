// `pnpm --filter @sbx/web dev` (S8 §13): `next dev` on 127.0.0.1:3001 and
// the dev auth proxy on 127.0.0.1:3000 in front of it. Open
// http://127.0.0.1:3000/__dev/login. The api is expected on
// 127.0.0.1:8081 (its proxied listener); without it /admin and the team
// pages still work.
//
// Defaults below are for local development only; set DATABASE_URL to the
// Postgres of the dev environment (S6) with the payload migrations applied
// (`pnpm --filter @sbx/payload migrate`).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOOPBACK, startAuthProxy } from "./auth-proxy.ts";

const PROXY_PORT = Number(process.env.SBX_DEV_PORT ?? 3000);
const NEXT_PORT = Number(process.env.SBX_DEV_NEXT_PORT ?? 3001);
const API_PORT = Number(process.env.SBX_DEV_API_PORT ?? 8081);
const OPERATOR_GROUP = "sbx-operators";

const env: Record<string, string | undefined> = {
	...process.env,
	SBX_APP_ORIGIN:
		process.env.SBX_APP_ORIGIN ?? `http://${LOOPBACK}:${PROXY_PORT}`,
	SBX_OPERATOR_GROUPS: process.env.SBX_OPERATOR_GROUPS ?? OPERATOR_GROUP,
	SBX_SBX_DOMAIN: process.env.SBX_SBX_DOMAIN ?? "sbx.localhost",
	SBX_API_PUBLIC_URL:
		process.env.SBX_API_PUBLIC_URL ?? `http://${LOOPBACK}:8080`,
	PAYLOAD_SECRET:
		process.env.PAYLOAD_SECRET ?? "dev-only-payload-secret-not-for-prod",
	DATABASE_URL:
		process.env.DATABASE_URL ?? "postgres://sbx:sbx@127.0.0.1:5432/sbx",
};

const appDir = fileURLToPath(new URL("..", import.meta.url));
const next = spawn(
	"pnpm",
	["exec", "next", "dev", "--hostname", LOOPBACK, "--port", String(NEXT_PORT)],
	{ cwd: appDir, env: env as NodeJS.ProcessEnv, stdio: "inherit" },
);

const proxy = await startAuthProxy({
	port: PROXY_PORT,
	web: { host: LOOPBACK, port: NEXT_PORT },
	api: { host: LOOPBACK, port: API_PORT },
	// The dev login form posts from the app origin.
	origin: env.SBX_APP_ORIGIN as string,
	operatorGroup:
		(env.SBX_OPERATOR_GROUPS ?? "").split(",")[0]?.trim() || OPERATOR_GROUP,
});
console.error(
	`[auth-proxy] ${proxy.url} -> next dev :${NEXT_PORT}, /api -> :${API_PORT}; log in at ${proxy.url}/__dev/login`,
);

let stopping = false;
async function stop(code: number) {
	if (stopping) return;
	stopping = true;
	next.kill("SIGTERM");
	await proxy.close();
	process.exit(code);
}
next.on("exit", (code) => void stop(code ?? 0));
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
