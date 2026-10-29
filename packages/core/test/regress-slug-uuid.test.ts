// Regression (S6 acceptance): the S4 slug grammar allowed a UUID-shaped slug,
// but findSandboxRow treats any UUID-shaped string as an id, so such a
// sandbox was unreachable by its slug and a slug equal to another sandbox's
// id resolved to that other sandbox. UUID-shaped slugs are now rejected.
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slugProblem } from "../src/index.ts";
import { expectCode, serviceEnv } from "./helpers/service.ts";

describe("UUID-shaped slugs", () => {
	it("slugProblem rejects a UUID shape, keeps other dashed hex slugs", () => {
		expect(slugProblem(randomUUID())).toMatch(/UUID/);
		expect(slugProblem(`${randomUUID().slice(0, 35)}a`)).toMatch(/UUID/);
		// Not a UUID: wrong group lengths, or no dashes.
		expect(slugProblem("0123abcd-0123-4567-89ab-0123456789a")).toBeNull();
		expect(slugProblem(randomUUID().replaceAll("-", "").slice(0, 32))).toBe(
			null,
		);
		// Prefixed public ids (S7 §5.3) are outside the grammar anyway.
		expect(slugProblem("sb_01jbx4q3m7f8r2t6v9w0y1z2a3")).not.toBeNull();
	});
});

describe.skipIf(skipPg())("UUID-shaped slugs (service)", () => {
	let t: TestDatabase;
	beforeAll(async () => {
		t = await createTestDatabase({ max: 10 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("create with a UUID-shaped slug is a validation error", async () => {
		const env = await serviceEnv(t.pool);
		const slug = `${randomUUID().slice(0, 35)}a`;
		await expectCode(env.svc.create(env.p, { slug }), "validation");
	});

	it("a slug equal to another sandbox's id is refused, the id still resolves", async () => {
		const env = await serviceEnv(t.pool);
		const a = await env.svc.create(env.p, {});
		await expectCode(
			env.svc.create(env.p, { slug: a.sandbox.id }),
			"validation",
		);
		await expectCode(
			env.svc.fork(env.p, a.sandbox.id, { slug: a.sandbox.id }),
			"validation",
		);
		expect((await env.svc.get(env.p, a.sandbox.id)).id).toBe(a.sandbox.id);
	});
});
