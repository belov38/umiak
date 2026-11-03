import { describe, expect, it } from "vitest";
import { sandboxEndpoints } from "../src/map/sandbox.ts";
import { testSettings } from "../src/testing/index.ts";

describe("preview URLs", () => {
	it.each([
		["http", "8085", "http://quiet-otter-{port}.umiak.test:8085"],
		["http", "80", "http://quiet-otter-{port}.umiak.test"],
		["https", "8443", "https://quiet-otter-{port}.umiak.test:8443"],
		["https", "443", "https://quiet-otter-{port}.umiak.test"],
	])("advertises %s previews on port %s", (scheme, port, url) => {
		const settings = testSettings({
			UMIAK_PREVIEW_SCHEME: scheme,
			UMIAK_PREVIEW_PORT: port,
		});
		expect(sandboxEndpoints("quiet-otter", settings).portUrlTemplate).toBe(url);
	});
});
