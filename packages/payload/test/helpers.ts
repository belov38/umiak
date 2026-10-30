import type { Payload } from "payload";
import {
	closeSbxPayload,
	getSbxPayload,
	type SbxPayloadOptions,
} from "../src/index.ts";

export function testOptions(databaseUrl: string): SbxPayloadOptions {
	return {
		databaseUrl,
		secret: "test-payload-secret-0123456789abcdef",
		operatorGroups: ["sbx-operators"],
		appOrigin: "https://app.sbx.test",
		poolMax: 4,
	};
}

/** The Payload instance of a test database; close it with closePayload. */
export function openPayload(databaseUrl: string): Promise<Payload> {
	return getSbxPayload(testOptions(databaseUrl));
}

export function closePayload(databaseUrl: string): Promise<void> {
	return closeSbxPayload(databaseUrl);
}
