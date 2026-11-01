// A separate Node process exposes GC without changing Vitest's runtime.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FileStore } from "../../src/auth/file-store.ts";
import { credentialName, getBearer } from "../../src/auth/token.ts";

const dir = process.argv[2] as string;
const lock = join(dir, ".lock");
const store = new FileStore(join(dir, "credentials.json"));
const profile = {
	apiUrl: "https://api.x",
	auth: "oidc" as const,
	issuer: "https://kc.x/realms/umiak",
};
await store.set(
	credentialName("default", profile),
	JSON.stringify({
		kind: "oidc",
		issuer: profile.issuer,
		clientId: "umiak-cli",
		accessToken: "old",
		refreshToken: "r1",
		expiresAt: new Date(0).toISOString(),
	}),
);
const collect = setInterval(() => globalThis.gc?.(), 10);
const guard = setTimeout(() => {
	console.error("refresh deadline was lost after GC");
	process.exit(1);
}, 3_000);
let requestAborted = false;
try {
	await getBearer({
		profileName: "default",
		profile,
		store,
		lockPath: lock,
		fetch: (req) =>
			new Promise<Response>((_, reject) => {
				req.signal.addEventListener("abort", () => {
					requestAborted = true;
					reject(req.signal.reason);
				});
			}),
		env: {},
		refreshTimeoutMs: 200,
	});
	throw new Error("refresh unexpectedly succeeded");
} catch (err) {
	console.log(
		JSON.stringify({
			code: (err as { code?: string }).code,
			retryable: (err as { retryable?: boolean }).retryable,
			lockReleased: !existsSync(lock),
			requestAborted,
		}),
	);
} finally {
	clearInterval(collect);
	clearTimeout(guard);
}
