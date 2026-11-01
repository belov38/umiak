// getUmiakPayload/closeUmiakPayload: one instance per database, shared by
// reference count (api and worker in one process, the E2E backend).
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPool } from "../src/db.ts";
import {
	closeUmiakPayload,
	getUmiakPayload,
	umiakPayloadRefs,
} from "../src/index.ts";
import { testOptions } from "./helpers.ts";

describe.skipIf(skipPg())("getUmiakPayload reference count", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
	});
	afterAll(async () => {
		while (t && umiakPayloadRefs(t.url) > 0) await closeUmiakPayload(t.url);
		await t?.drop();
	});

	it("shares one instance; the first close keeps it, the last destroys it", async () => {
		const a = await getUmiakPayload({ ...testOptions(t.url), poolMax: 2 });
		const b = await getUmiakPayload({ ...testOptions(t.url), poolMax: 5 });
		expect(b).toBe(a);
		expect(umiakPayloadRefs(t.url)).toBe(2);
		// The larger poolMax of the second caller wins.
		const pool = dbPool(a) as unknown as { options: { max: number } };
		expect(pool.options.max).toBe(5);
		// A smaller one later does not shrink it.
		const c = await getUmiakPayload({ ...testOptions(t.url), poolMax: 1 });
		expect(c).toBe(a);
		expect(pool.options.max).toBe(5);
		expect(umiakPayloadRefs(t.url)).toBe(3);

		await closeUmiakPayload(t.url);
		await closeUmiakPayload(t.url);
		expect(umiakPayloadRefs(t.url)).toBe(1);
		// Still usable by the remaining holder.
		const r = await dbPool(a)?.query<{ one: number }>("SELECT 1 AS one");
		expect(r?.rows[0]?.one).toBe(1);

		await closeUmiakPayload(t.url);
		expect(umiakPayloadRefs(t.url)).toBe(0);
		// Extra closes do nothing.
		await closeUmiakPayload(t.url);
		expect(umiakPayloadRefs(t.url)).toBe(0);

		// The next open builds a new instance.
		const d = await getUmiakPayload({ ...testOptions(t.url), poolMax: 2 });
		expect(d).not.toBe(a);
		expect(umiakPayloadRefs(t.url)).toBe(1);
		await closeUmiakPayload(t.url);
	});
});
