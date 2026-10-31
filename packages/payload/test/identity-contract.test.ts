import { runIdentityStoreContract } from "@sbx/auth/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import type { Payload } from "payload";
import { afterAll, beforeAll, describe } from "vitest";
import { getSbxPayload, migrateSbxPayload } from "../src/index.ts";
import { payloadContractSubject } from "../src/testing.ts";
import { closePayload, testOptions } from "./helpers.ts";

describe.skipIf(skipPg())("PayloadIdentityStore", () => {
	let t: TestDatabase;
	let payload: Payload;

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await getSbxPayload({ ...testOptions(t.url), poolMax: 12 });
		await migrateSbxPayload(payload);
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	runIdentityStoreContract("payload", async () =>
		payloadContractSubject(payload),
	);
});
