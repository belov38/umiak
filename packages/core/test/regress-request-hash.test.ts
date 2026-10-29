// Regression (S6 acceptance): idempotency_keys.request_hash and
// operations.request.bodyHash were plain sha256 over bodies with env and
// secret values, so a stored hash confirmed a guessed secret offline. They
// are now keyed (HMAC under a subkey of the data key ring) and carry the key
// version, so a key rotation inside the 24 h idempotency window still
// replays the same request.
import { createHash, randomBytes } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, KeyRing, SandboxServiceImpl } from "../src/index.ts";
import { expectCode, seedSandbox, serviceEnv } from "./helpers/service.ts";

describe.skipIf(skipPg())("keyed request hashes", () => {
	let t: TestDatabase;
	beforeAll(async () => {
		t = await createTestDatabase({ max: 10 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	const k1 = randomBytes(32).toString("base64");
	const k2 = randomBytes(32).toString("base64");
	const ring1 = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
	const ring12 = KeyRing.fromObject({ current: 2, keys: { "1": k1, "2": k2 } });

	async function envWith() {
		const env = await serviceEnv(t.pool);
		const svc = (keys: KeyRing) =>
			new SandboxServiceImpl({
				pool: t.pool,
				config: env.config,
				keys,
				jobs: env.jobs,
			});
		return { env, before: svc(ring1), after: svc(ring12) };
	}

	it("create: the stored hash is not a sha256 of the body; a rotation keeps the replay", async () => {
		const { env, before, after } = await envWith();
		const body = { secrets: { TOKEN: "hunter2" }, env: { A: "1" } };
		const first = await before.create(env.p, body, "key-1");

		const r = await t.pool.query<{ request_hash: Buffer }>(
			"SELECT request_hash FROM runtime.idempotency_keys WHERE sandbox_id = $1",
			[first.sandbox.id],
		);
		const stored = r.rows[0]?.request_hash;
		const plain = createHash("sha256")
			.update(`sandboxes.create\n${canonicalJson(body)}`)
			.digest();
		expect(stored?.length).toBe(36);
		expect(stored?.includes(plain)).toBe(false);

		// Key 2 became current within the 24 h window: same body replays.
		const again = await after.create(env.p, body, "key-1");
		expect(again.sandbox.id).toBe(first.sandbox.id);
		expect(again.operation.id).toBe(first.operation.id);
		// Another secret value under the same key is still refused.
		await expectCode(
			after.create(env.p, { ...body, secrets: { TOKEN: "x" } }, "key-1"),
			"idempotency_key_reused",
		);
	});

	it("resume: the active resume is returned for the same body across a rotation", async () => {
		const { env, before, after } = await envWith();
		const s = await seedSandbox(t.pool, env, {
			state: "stopped",
			machineState: "stopped",
		});
		const body = { secrets: { TOKEN: "hunter2" } };
		// seedSandbox encrypted the secrets with env.keys; re-encrypt with ring1.
		const blob = ring1.encrypt(s.sandboxId, {
			env: {},
			secrets: {},
			secretFiles: [],
		});
		await t.pool.query(
			`UPDATE runtime.sandbox_secrets SET key_version = $2, nonce = $3, ciphertext = $4
			 WHERE sandbox_id = $1`,
			[s.sandboxId, blob.keyVersion, blob.nonce, blob.ciphertext],
		);
		const op = await before.resume(env.p, s.sandboxId, body);
		const hash = String(op.request.bodyHash);
		const plain = createHash("sha256")
			.update(`sandboxes.resume\n${canonicalJson(body)}`)
			.digest("hex");
		expect(hash).toMatch(/^[0-9a-f]{72}$/);
		expect(hash.includes(plain)).toBe(false);
		expect(JSON.stringify(op.request)).not.toContain("hunter2");

		expect((await after.resume(env.p, s.sandboxId, body)).id).toBe(op.id);
		await expectCode(
			after.resume(env.p, s.sandboxId, { secrets: { TOKEN: "x" } }),
			"operation_in_progress",
		);
	});
});
