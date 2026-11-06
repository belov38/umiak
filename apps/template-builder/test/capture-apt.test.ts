import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const harness = resolve(import.meta.dirname, "fixtures/capture-apt-harness.py");
const exporter = resolve(
	import.meta.dirname,
	"../../../infra/templates/linux/capture-apt.py",
);
function capture(scenario: string) {
	return execFileSync("python", [harness, exporter, scenario], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
for (const scenario of [
	"stale-duplicates",
	"live-discovery",
	"proxy-http",
	"proxy-canonical-after",
])
	it(`captures pinned snapshot bytes with ${scenario}`, () => {
		const result = JSON.parse(capture(scenario));
		expect(result.repositories.map((r: { name: string }) => r.name)).toEqual([
			"ubuntu-resolute",
			"ubuntu-resolute-updates",
			"ubuntu-resolute-security",
			"ubuntu-resolute-backports",
		]);
		for (const repo of result.repositories)
			expect(repo.indexes).toEqual([
				"main/binary-amd64/Packages",
				"universe/binary-amd64/Packages",
			]);
		const indexReads = result.commands.filter(
			(cmd: string[]) => cmd[0] === "/usr/lib/apt/apt-helper",
		);
		expect(indexReads).toHaveLength(8);
		for (const cmd of indexReads)
			expect(cmd[2]).toContain(
				"snapshot.ubuntu.com_ubuntu_20261030T000000Z_dists_",
			);
	});
it("retains Docker and xtradeb targets independently of Ubuntu snapshot discovery", () => {
	const result = JSON.parse(capture("third-party"));
	expect(result.repositories.map((r: { name: string }) => r.name)).toContain(
		"docker-resolute",
	);
	expect(result.repositories.map((r: { name: string }) => r.name)).toContain(
		"xtradeb-resolute",
	);
});
for (const [scenario, message] of [
	["non-docker-no-doc", "package license notice missing: fixture"],
	["missing-release", "apt InRelease missing for an active index"],
	["origin-mismatch", "apt InRelease does not match its index target"],
	["suite-mismatch", "apt InRelease does not match its index target"],
	["outside-lists", "unexpected apt index location"],
	["live-only-suite", "an Ubuntu suite has no pinned snapshot index"],
	["proxy-wrong-id", "an Ubuntu suite has no pinned snapshot index"],
	["proxy-mixed-ids", "expected exactly one pinned Ubuntu apt snapshot"],
	["two-snapshot-ids", "expected exactly one pinned Ubuntu apt snapshot"],
	["missing-snapshot-id", "expected exactly one pinned Ubuntu apt snapshot"],
	["two-snapshot-base-mirrors", "ambiguous captured apt Release"],
] as const)
	it(`rejects ${scenario} without falling back to live discovery Releases`, () => {
		try {
			capture(scenario);
			throw Error("unexpected successful export");
		} catch (error) {
			expect(String((error as { stderr?: unknown }).stderr)).toContain(message);
		}
	});

for (const scenario of ["docker-no-doc", "docker-doc-notices"])
	it(`records the narrow Docker notice exception: ${scenario}`, () => {
		expect(() => capture(scenario)).not.toThrow();
	});

it("records the narrow upstream GPL Sunshine notice exception without a doc directory", () => {
	expect(() => capture("sunshine-no-doc")).not.toThrow();
});
