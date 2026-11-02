import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	ConfigReader,
	PlatformDefaults,
	PoolTarget,
	Quota,
	SizeConfig,
	TemplateConfig,
} from "../src/types.ts";

// Contract of ConfigReader (S6 §5.11, S8 §7). Run against StaticConfigReader
// here and against PayloadConfigReader in @umiak/payload. The fixture lists
// values in configuration order; `make` loads them into the reader under
// test. Values differ from the defaults, so a reader that ignores a field
// fails.

/** Everything a reader under test is loaded with. */
export interface ConfigFixture {
	/** In configuration order (not slug order). */
	templates: TemplateConfig[];
	/** In configuration order (not slug order). */
	sizes: SizeConfig[];
	pools: PoolTarget[];
	/** Every field set to a non-default value. */
	defaults: PlatformDefaults;
	/** The quota of teams (and of those fields a team leaves empty). */
	defaultQuota: Quota;
	/** A team whose quota sets only some fields; `id` is a UUID. */
	team: { id: string; quota: Partial<Quota> };
}

export interface ConfigContractOptions {
	/** What a team that does not exist gets: the default quota or zeros (S8 §7). */
	unknownTeamQuota: "default" | "zero";
}

export type ConfigReaderSubject = ConfigReader & { close?(): Promise<void> };

/** A fresh fixture; slugs are fixed, the team id is new on every call. */
export function makeConfigFixture(): ConfigFixture {
	return {
		sizes: [
			{ slug: "4gb", vcpu: 4, memoryMb: 4096 },
			{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
		],
		templates: [
			{
				slug: "win11",
				name: "Windows 11",
				os: "windows",
				enabled: false,
				defaultSize: "4gb",
				allowedSizes: ["4gb"],
				loginUser: "Administrator",
				capabilities: ["exec", "files", "desktop"],
			},
			{
				slug: "linux",
				name: "Ubuntu 26.04",
				os: "linux",
				enabled: true,
				defaultSize: "2gb",
				allowedSizes: ["2gb", "4gb"],
				loginUser: "dev",
				capabilities: ["exec", "files", "ssh", "desktop"],
			},
		],
		pools: [
			{ templateSlug: "linux", sizeSlug: "2gb", target: 2, maxAgeHours: 12 },
			{
				templateSlug: "linux",
				sizeSlug: "4gb",
				providerId: "0197c2a0-0000-7000-8000-000000000001",
				target: 1,
			},
		],
		defaults: {
			ttlSeconds: 7200,
			maxTtlSeconds: 86400,
			idleTimeoutSeconds: 600,
			stoppedRetentionDays: 14,
			errorRetentionDays: 3,
			recoverMinIntervalSeconds: 120,
			defaultTemplate: "linux",
			publicPortsEnabled: false,
			publicDesktopEnabled: true,
			ssoPortPolicy: "team",
			ssoPolicyEpoch: 4,
		},
		defaultQuota: {
			maxActiveSandboxes: 2,
			maxRamMb: 4096,
			maxSavedSnapshots: 5,
		},
		team: {
			id: randomUUID(),
			quota: { maxActiveSandboxes: 7, maxRamMb: 16384 },
		},
	};
}

function byPool(a: PoolTarget, b: PoolTarget): number {
	const k = (p: PoolTarget) =>
		`${p.templateSlug}/${p.sizeSlug}/${p.providerId ?? ""}`;
	return k(a).localeCompare(k(b));
}

export function runConfigReaderContract(
	name: string,
	make: (fx: ConfigFixture) => Promise<ConfigReaderSubject>,
	opts: ConfigContractOptions = { unknownTeamQuota: "zero" },
): void {
	describe(`ConfigReader contract: ${name}`, () => {
		const fx = makeConfigFixture();
		let reader: ConfigReaderSubject;

		beforeAll(async () => {
			reader = await make(fx);
		});
		afterAll(async () => {
			await reader?.close?.();
		});

		it("reads a template by slug, enabled or not, and null for an unknown one", async () => {
			for (const t of fx.templates) {
				expect(await reader.template(t.slug)).toEqual(t);
			}
			expect((await reader.template("win11"))?.enabled).toBe(false);
			expect((await reader.template("win11"))?.os).toBe("windows");
			expect(await reader.template("nope")).toBeNull();
		});

		it("reads a size by slug and null for an unknown one", async () => {
			for (const s of fx.sizes) {
				expect(await reader.size(s.slug)).toEqual(s);
			}
			expect(await reader.size("nope")).toBeNull();
		});

		it("lists every template (also disabled) in configuration order, as copies", async () => {
			const list = await reader.templates();
			expect(list).toEqual(fx.templates);
			expect(list.map((t) => t.slug)).toEqual(["win11", "linux"]);
			list[1]?.allowedSizes.push("x");
			list[1]?.capabilities.push("x");
			expect((await reader.template("linux"))?.allowedSizes).toEqual([
				"2gb",
				"4gb",
			]);
			expect((await reader.templates())[1]?.capabilities).toEqual([
				"exec",
				"files",
				"ssh",
				"desktop",
			]);
		});

		it("lists every size in configuration order", async () => {
			expect(await reader.sizes()).toEqual(fx.sizes);
		});

		it("lists the pool targets", async () => {
			expect([...(await reader.poolTargets())].sort(byPool)).toEqual(
				[...fx.pools].sort(byPool),
			);
		});

		it("fills the empty fields of a team quota from the default quota", async () => {
			expect(await reader.teamQuota(fx.team.id)).toEqual({
				maxActiveSandboxes: 7,
				maxRamMb: 16384,
				maxSavedSnapshots: 5,
			});
		});

		it("answers for a team that does not exist", async () => {
			const expected: Quota =
				opts.unknownTeamQuota === "default"
					? fx.defaultQuota
					: { maxActiveSandboxes: 0, maxRamMb: 0, maxSavedSnapshots: 0 };
			expect(await reader.teamQuota(randomUUID())).toEqual(expected);
			// Not a UUID: a database must not fail on it.
			expect(await reader.teamQuota("not-a-uuid")).toEqual(expected);
		});

		it("returns every platform default", async () => {
			expect(await reader.defaults()).toEqual(fx.defaults);
		});
	});
}
