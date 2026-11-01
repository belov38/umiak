import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { versionsSchema } from "../src/recipe.ts";
import { formatVersionsToml } from "../src/versions-update.ts";

const base = parse(
	readFileSync(
		resolve(
			import.meta.dirname,
			"../../../infra/templates/linux/versions.toml",
		),
		"utf8",
	),
);
const pin = { version: "1.2.3", sha256: "a".repeat(64) };
const desktop = { sunshine: pin, moonlight_web: pin, cua_driver: pin };

describe("desktop artifact pins", () => {
	it("validates all three artifacts and preserves them in the build seed TOML", () => {
		const versions = versionsSchema.parse({ ...base, desktop });
		expect(parse(formatVersionsToml(versions)).desktop).toEqual(desktop);
	});
	it("keeps Linux recipes without desktop pins compatible", () => {
		expect(versionsSchema.parse(base)).not.toHaveProperty("desktop");
	});
	it.each(["sunshine", "moonlight_web", "cua_driver"])(
		"requires a verified hash for %s",
		(name) => {
			expect(() =>
				versionsSchema.parse({
					...base,
					desktop: { ...desktop, [name]: { ...pin, sha256: "bad" } },
				}),
			).toThrow(/sha256/);
		},
	);
	it("rejects incomplete desktop stacks and misspelled component names", () => {
		expect(() =>
			versionsSchema.parse({ ...base, desktop: { sunshine: pin } }),
		).toThrow();
		expect(() =>
			versionsSchema.parse({
				...base,
				desktop: { ...desktop, moonlight: pin },
			}),
		).toThrow();
	});
});
