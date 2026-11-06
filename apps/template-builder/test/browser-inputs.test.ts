import { readFileSync } from "node:fs";
import * as openpgp from "openpgp";
import { expect, it } from "vitest";

it("pins the native Ubuntu PPA authority and exact stable Chromium deb inputs", async () => {
	const root = new URL("../../../infra/templates/", import.meta.url);
	const key = await openpgp.readKey({
		armoredKey: readFileSync(new URL("keys/xtradeb-apps.asc", root), "utf8"),
	});
	const pins = JSON.parse(
		readFileSync(new URL("linux/layer-inputs.json", root), "utf8"),
	);
	expect(key.getFingerprint()).toBe(pins.chromium.keyFingerprint.toLowerCase());
	expect(pins.chromium.repository).toBe(
		"https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/",
	);
	expect(pins.chromium.suite).toBe("resolute");
	expect(pins.chromium.version).toMatch(
		/^\d+\.\d+\.\d+\.\d+-\d+xtradeb\d+\.2604\.\d+$/,
	);
	expect(Object.keys(pins.chromium.packages).sort()).toEqual([
		"chromium",
		"chromium-common",
		"chromium-sandbox",
	]);
	for (const hash of Object.values(pins.chromium.packages))
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
});
