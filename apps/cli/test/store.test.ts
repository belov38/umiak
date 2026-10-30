// Credential stores, their selection and the config lock (unit, no api).
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/auth/file-store.ts";
import { KeychainStore, type SecretsBackend } from "../src/auth/keychain.ts";
import { removeIfStale, withFileLock } from "../src/auth/lock.ts";
import {
	AutoStore,
	openCredentialStore,
	parseStoreChoice,
} from "../src/auth/store.ts";
import { credentialName, getBearer } from "../src/auth/token.ts";
import { exitCodeOf } from "../src/exit-codes.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sbx-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An in-memory Bun.secrets that records its calls. */
function fakeSecrets(): SecretsBackend & {
	calls: unknown[];
	data: Map<string, string>;
} {
	const data = new Map<string, string>();
	const calls: unknown[] = [];
	return {
		calls,
		data,
		async get(o) {
			calls.push({ op: "get", ...o });
			return data.get(`${o.service}/${o.name}`) ?? null;
		},
		async set(o) {
			calls.push({ op: "set", ...o });
			data.set(`${o.service}/${o.name}`, o.value);
		},
		async delete(o) {
			calls.push({ op: "delete", ...o });
			return data.delete(`${o.service}/${o.name}`);
		},
	};
}

function brokenSecrets(): SecretsBackend {
	const fail = async () => {
		throw new Error("no secret service");
	};
	return { get: fail, set: fail, delete: fail };
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("FileStore", () => {
	it("keeps values in credentials.json with mode 0600 in a 0700 dir", async () => {
		const path = join(dir, "sbx", "credentials.json");
		const s = new FileStore(path);
		expect(await s.get("a@x")).toBeNull();
		await s.set("a@x", "v1");
		await s.set("b@y", "v2");
		expect(await s.get("a@x")).toBe("v1");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			"a@x": "v1",
			"b@y": "v2",
		});
		expect(mode(path)).toBe(0o600);
		expect(mode(join(dir, "sbx"))).toBe(0o700);
		await s.delete("a@x");
		expect(await s.get("a@x")).toBeNull();
		expect(await s.get("b@y")).toBe("v2");
	});

	it("puts a file others can read back to 0600", async () => {
		const path = join(dir, "credentials.json");
		const s = new FileStore(path);
		await s.set("a", "v");
		chmodSync(path, 0o644);
		expect(await s.get("a")).toBe("v");
		expect(mode(path)).toBe(0o600);
	});
});

describe("KeychainStore", () => {
	it("uses service sbx, the entry name and persist local", async () => {
		const secrets = fakeSecrets();
		const s = new KeychainStore(secrets);
		await s.set("default@https://kc/realms/sbx", "tok");
		expect(await s.get("default@https://kc/realms/sbx")).toBe("tok");
		await s.delete("default@https://kc/realms/sbx");
		expect(secrets.calls).toEqual([
			{
				op: "set",
				service: "sbx",
				name: "default@https://kc/realms/sbx",
				value: "tok",
				persist: "local",
			},
			{ op: "get", service: "sbx", name: "default@https://kc/realms/sbx" },
			{ op: "delete", service: "sbx", name: "default@https://kc/realms/sbx" },
		]);
	});

	it("without Bun.secrets fails with keychain_unavailable", async () => {
		const s = new KeychainStore(undefined);
		await expect(s.get("x")).rejects.toMatchObject({
			code: "keychain_unavailable",
		});
	});
});

describe("store selection", () => {
	const file = () => join(dir, "credentials.json");

	it("file and keychain are taken as asked", () => {
		const o = { file: file(), secrets: fakeSecrets(), warn: () => {} };
		expect(openCredentialStore("file", o)).toBeInstanceOf(FileStore);
		expect(openCredentialStore("keychain", o)).toBeInstanceOf(KeychainStore);
		expect(openCredentialStore("auto", o)).toBeInstanceOf(AutoStore);
	});

	it("auto stores in the keychain when it works, and leaves no file", async () => {
		const secrets = fakeSecrets();
		const warn: string[] = [];
		const s = openCredentialStore("auto", {
			file: file(),
			secrets,
			warn: (m) => void warn.push(m),
		});
		await s.set("p@u", "secret");
		expect(s.kind).toBe("keychain");
		expect(secrets.data.get("sbx/p@u")).toBe("secret");
		expect(existsSync(file())).toBe(false);
		expect(await s.get("p@u")).toBe("secret");
		expect(warn).toEqual([]);
	});

	it("auto falls back to the file when the keychain fails, with one warning", async () => {
		const warn: string[] = [];
		const s = openCredentialStore("auto", {
			file: file(),
			secrets: brokenSecrets(),
			warn: (m) => void warn.push(m),
		});
		await s.set("p@u", "secret");
		await s.set("q@u", "other");
		expect(s.kind).toBe("file");
		expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
			"p@u": "secret",
			"q@u": "other",
		});
		expect(await s.get("p@u")).toBe("secret");
		expect(warn).toHaveLength(1);
		expect(warn[0]).toMatch(/keychain unavailable.*no secret service/);
		await s.delete("p@u");
		expect(await s.get("p@u")).toBeNull();
	});

	it("auto without Bun.secrets (Node) uses the file", async () => {
		const s = openCredentialStore("auto", {
			file: file(),
			secrets: undefined,
			warn: () => {},
		});
		await s.set("p@u", "v");
		expect(s.kind).toBe("file");
		expect(await s.get("p@u")).toBe("v");
	});

	it("auto reads a login that went to the file while the keychain works now", async () => {
		await new FileStore(file()).set("p@u", "from-file");
		const s = openCredentialStore("auto", {
			file: file(),
			secrets: fakeSecrets(),
			warn: () => {},
		});
		expect(await s.get("p@u")).toBe("from-file");
	});

	it("an unknown --credential-store is a usage error (exit 2)", () => {
		expect(parseStoreChoice("file")).toBe("file");
		let err: unknown;
		try {
			parseStoreChoice("vault");
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({ code: "usage" });
		expect(exitCodeOf(err)).toBe(2);
	});

	it("entry names are <profile>@<issuer> for oidc and <profile>@<apiUrl> for keys", () => {
		expect(
			credentialName("default", {
				apiUrl: "https://api.x",
				auth: "oidc",
				issuer: "https://kc.x/realms/sbx",
			}),
		).toBe("default@https://kc.x/realms/sbx");
		expect(credentialName("ci", { apiUrl: "https://api.x", auth: "key" })).toBe(
			"ci@https://api.x",
		);
	});
});

describe("withFileLock", () => {
	it("runs holders one at a time and removes the lock file", async () => {
		const lock = join(dir, "sbx", ".lock");
		let inside = 0;
		let maxInside = 0;
		const job = (n: number) =>
			withFileLock(lock, async () => {
				inside++;
				maxInside = Math.max(maxInside, inside);
				await new Promise((r) => setTimeout(r, 30));
				inside--;
				return n;
			});
		expect(await Promise.all([job(1), job(2), job(3)])).toEqual([1, 2, 3]);
		expect(maxInside).toBe(1);
		expect(existsSync(lock)).toBe(false);
	});

	it("releases the lock when the holder throws", async () => {
		const lock = join(dir, ".lock");
		await expect(
			withFileLock(lock, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});

	it("takes over a lock older than 30 s", async () => {
		const lock = join(dir, ".lock");
		writeFileSync(lock, "4242 dead\n");
		const old = new Date(Date.now() - 31_000);
		utimesSync(lock, old, old);
		const started = Date.now();
		expect(await withFileLock(lock, async () => "got")).toBe("got");
		// At once, not after a lock wait (room for a loaded machine).
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("writes a unique owner token into the lock", async () => {
		const lock = join(dir, ".lock");
		const seen: string[] = [];
		for (let i = 0; i < 2; i++) {
			await withFileLock(lock, async () => {
				seen.push(readFileSync(lock, "utf8"));
			});
		}
		expect(seen[0]).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36} `));
		expect(seen[1]).not.toBe(seen[0]);
	});

	it("does not remove a lock that is no longer its own on release", async () => {
		const lock = join(dir, ".lock");
		await withFileLock(lock, async () => {
			// Taken over as stale meanwhile, then created by another process.
			writeFileSync(lock, "4243 other-owner\n");
		});
		expect(readFileSync(lock, "utf8")).toBe("4243 other-owner\n");
	});

	it("removeIfStale removes an old lock and keeps a fresh one", () => {
		const lock = join(dir, ".lock");
		writeFileSync(lock, "4242 dead\n");
		const old = new Date(Date.now() - 31_000);
		utimesSync(lock, old, old);
		removeIfStale(lock, 30_000);
		expect(existsSync(lock)).toBe(false);
		writeFileSync(lock, "4242 alive\n");
		removeIfStale(lock, 30_000);
		expect(readFileSync(lock, "utf8")).toBe("4242 alive\n");
		// No leftovers of the rename.
		expect(readdirSync(dir)).toEqual([".lock"]);
	});

	it("waits for a fresh lock and gives up with lock_timeout", async () => {
		const lock = join(dir, ".lock");
		mkdirSync(dir, { recursive: true });
		writeFileSync(lock, "4242 alive\n");
		await expect(
			withFileLock(lock, async () => "never", { timeoutMs: 200, retryMs: 20 }),
		).rejects.toMatchObject({ code: "lock_timeout", retryable: true });
		expect(existsSync(lock)).toBe(true);
	});
});

describe("getBearer refresh", () => {
	it("a refresh that hangs is given up within its timeout and the lock is released", async () => {
		const lock = join(dir, ".lock");
		const file = new FileStore(join(dir, "credentials.json"));
		const profile = {
			apiUrl: "https://api.x",
			auth: "oidc" as const,
			issuer: "https://kc.x/realms/sbx",
		};
		await file.set(
			credentialName("default", profile),
			JSON.stringify({
				kind: "oidc",
				issuer: profile.issuer,
				clientId: "sbx-cli",
				accessToken: "old",
				refreshToken: "r1",
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			}),
		);
		// Never answers; only the request's signal ends it.
		const hanging = (req: Request) =>
			new Promise<Response>((_, reject) => {
				req.signal.addEventListener("abort", () => reject(req.signal.reason));
			});
		const started = Date.now();
		await expect(
			getBearer({
				profileName: "default",
				profile,
				store: file,
				lockPath: lock,
				fetch: hanging,
				env: {},
				refreshTimeoutMs: 200,
			}),
		).rejects.toMatchObject({ code: "network_error", retryable: true });
		// The hanging request never ends by itself (room for a loaded machine).
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(existsSync(lock)).toBe(false);
	});

	it("the refresh timeout is below the stale age of the lock", async () => {
		const { LOCK_STALE_MS } = await import("../src/auth/lock.ts");
		const { REFRESH_TIMEOUT_MS } = await import("../src/auth/token.ts");
		expect(REFRESH_TIMEOUT_MS).toBeLessThan(LOCK_STALE_MS);
	});
});
