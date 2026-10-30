// SSH keys of a person (S7 §11.3): person only, §11.3 key types, the
// fingerprint is unique across the platform.
import { decodeUuid, parseSshPublicKey, signUserCertificate } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessResponse } from "./helpers/harness.ts";
import {
	bareKey,
	ecdsaP256PublicKey,
	ed25519PublicKey,
	rsaPublicKey,
	testSshCa,
} from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

describe.skipIf(skipPg())("SSH keys (S7 §11.3)", () => {
	let db: TestDatabase;
	let w: ApiWorld;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	async function person() {
		const p = await w.dbSession({ role: "member" });
		return {
			...p,
			req: (method: string, path: string, json?: unknown) =>
				p.h.request(method, path, {
					headers: p.headers,
					...(json === undefined ? {} : { json }),
				}),
		};
	}

	it("a person adds a key: 201 {id sshk_, name, fingerprint, type, createdAt, lastUsedAt}; GET lists it", async () => {
		const p = await person();
		const line = ed25519PublicKey("me@laptop");
		const r = await p.req("POST", "/v1/ssh-keys", {
			name: "laptop",
			publicKey: `  ${line}\n`,
		});
		expect(r.status, r.text).toBe(201);
		const k = body(r);
		expect(k).toEqual({
			id: expect.stringMatching(/^sshk_[0-9a-z]{26}$/),
			name: "laptop",
			fingerprint: parseSshPublicKey(line).fingerprint,
			type: "ssh-ed25519",
			createdAt: expect.any(String),
			lastUsedAt: null,
		});
		const stored = await w.identity.listSshKeys(p.userId);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(decodeUuid("sshKey", k.id));
		expect(stored[0]?.publicKey).toBe(bareKey(line));

		const list = await p.req("GET", "/v1/ssh-keys");
		expect(list.status).toBe(200);
		expect(body(list)).toEqual({ data: [k] });
	});

	it("ecdsa and RSA 3072 are accepted; RSA 2048, DSA, certificates and garbage are 400", async () => {
		const p = await person();
		const ec = await p.req("POST", "/v1/ssh-keys", {
			name: "ec",
			publicKey: ecdsaP256PublicKey(),
		});
		expect(ec.status).toBe(201);
		expect(body(ec).type).toBe("ecdsa-sha2-nistp256");
		const rsa = await p.req("POST", "/v1/ssh-keys", {
			name: "rsa",
			publicKey: rsaPublicKey(3072),
		});
		expect(rsa.status).toBe(201);
		expect(body(rsa).type).toBe("ssh-rsa");

		const ca = testSshCa();
		const cert = signUserCertificate(ca, {
			publicKey: ed25519PublicKey(),
			keyId: "k",
			principals: ["p"],
			validAfter: new Date(),
			validBefore: new Date(Date.now() + 60_000),
		}).certificate;
		for (const publicKey of [
			rsaPublicKey(2048),
			cert,
			"ssh-dss AAAAB3NzaC1kc3MAAACBAP",
			"not a key",
		]) {
			const r = await p.req("POST", "/v1/ssh-keys", { name: "x", publicKey });
			expect(r.status, publicKey.slice(0, 20)).toBe(400);
			expect(body(r).error.code).toBe("validation");
		}
		for (const json of [
			{ publicKey: ed25519PublicKey() },
			{ name: "", publicKey: ed25519PublicKey() },
			{ name: "x".repeat(101), publicKey: ed25519PublicKey() },
			{ name: "x", publicKey: ed25519PublicKey(), extra: 1 },
		]) {
			const r = await p.req("POST", "/v1/ssh-keys", json);
			expect(r.status).toBe(400);
		}
		expect(await w.identity.listSshKeys(p.userId)).toHaveLength(2);
	});

	it("a fingerprint is unique on the platform: the same key again, by anyone, is 409 ssh_key_in_use", async () => {
		const a = await person();
		const b = await person();
		const line = ed25519PublicKey();
		expect(
			(await a.req("POST", "/v1/ssh-keys", { name: "a", publicKey: line }))
				.status,
		).toBe(201);
		for (const p of [a, b]) {
			const r = await p.req("POST", "/v1/ssh-keys", {
				name: "again",
				// Another comment, same key.
				publicKey: `${bareKey(line)} other@host`,
			});
			expect(r.status).toBe(409);
			expect(body(r).error.code).toBe("ssh_key_in_use");
		}
		expect(await w.identity.listSshKeys(b.userId)).toEqual([]);
	});

	it("DELETE removes an own key (204); another person's key or an unknown id is 404", async () => {
		const a = await person();
		const b = await person();
		const r = await a.req("POST", "/v1/ssh-keys", {
			name: "a",
			publicKey: ed25519PublicKey(),
		});
		const id = body(r).id;
		const foreign = await b.req("DELETE", `/v1/ssh-keys/${id}`);
		expect(foreign.status).toBe(404);
		expect(await w.identity.listSshKeys(a.userId)).toHaveLength(1);
		expect((await a.req("DELETE", `/v1/ssh-keys/${id}`)).status).toBe(204);
		expect((await a.req("DELETE", `/v1/ssh-keys/${id}`)).status).toBe(404);
		expect((await a.req("DELETE", "/v1/ssh-keys/nope")).status).toBe(404);
		expect(await w.identity.listSshKeys(a.userId)).toEqual([]);
	});

	it("a team key: 403 user_required on every route", async () => {
		const h = w.harness();
		for (const [method, json] of [
			["GET", undefined],
			["POST", { name: "x", publicKey: ed25519PublicKey() }],
			["DELETE", undefined],
		] as const) {
			const path =
				method === "DELETE"
					? "/v1/ssh-keys/sshk_01jbx2v7d3m6c8q9w0e4r5t6y7"
					: "/v1/ssh-keys";
			const r = await h.request(
				method,
				path,
				json === undefined ? {} : { json },
			);
			expect(r.status, method).toBe(403);
			expect(body(r).error).toMatchObject({
				code: "forbidden",
				details: { reason: "user_required" },
			});
		}
	});

	it("a team key without ssh:connect is told user_required, not the scope", async () => {
		const k = await w.key(["sandboxes:read"]);
		const r = await w
			.harness({ bearer: k.secret })
			.request("GET", "/v1/ssh-keys");
		expect(r.status).toBe(403);
		expect(body(r).error.details).toEqual({ reason: "user_required" });
	});
});
