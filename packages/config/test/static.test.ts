import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, StaticConfigReader } from "../src/index.ts";
import { runConfigReaderContract } from "../src/testing.ts";

const POC = fileURLToPath(new URL("./fixtures/poc.yaml", import.meta.url));

// The static reader gives an unknown team the default quota (S6 S3).
runConfigReaderContract(
	"StaticConfigReader",
	async (fx) =>
		StaticConfigReader.fromObject({
			templates: fx.templates,
			sizes: fx.sizes,
			pools: fx.pools,
			quotas: {
				default: fx.defaultQuota,
				teams: { [fx.team.id]: fx.team.quota },
			},
			defaults: fx.defaults,
		}),
	{ unknownTeamQuota: "default" },
);

describe("StaticConfigReader.fromFile(poc.yaml)", () => {
	const reader = StaticConfigReader.fromFile(POC);

	it("reads templates and sizes", async () => {
		expect(await reader.template("linux")).toEqual({
			slug: "linux",
			name: "linux",
			os: "linux",
			enabled: true,
			defaultSize: "2gb",
			allowedSizes: ["2gb"],
			loginUser: "user",
			capabilities: ["exec", "files", "ssh"],
		});
		expect(await reader.size("2gb")).toEqual({
			slug: "2gb",
			vcpu: 2,
			memoryMb: 2048,
		});
		expect(await reader.template("nope")).toBeNull();
		expect(await reader.size("nope")).toBeNull();
	});

	it("reads pool targets", async () => {
		expect(await reader.poolTargets()).toEqual([
			{ templateSlug: "linux", sizeSlug: "2gb", target: 1 },
		]);
	});

	it("applies platform defaults", async () => {
		expect(await reader.defaults()).toEqual({
			ttlSeconds: null,
			maxTtlSeconds: 604800,
			idleTimeoutSeconds: 900,
			stoppedRetentionDays: null,
			errorRetentionDays: 7,
			recoverMinIntervalSeconds: 600,
			defaultTemplate: "linux",
			publicPortsEnabled: true,
		});
	});

	it("returns the default quota for an unknown team", async () => {
		const q = { maxActiveSandboxes: 3, maxRamMb: 6144, maxSavedSnapshots: 10 };
		expect(await reader.teamQuota("unknown")).toEqual(q);
	});

	it("exposes the topology", () => {
		const topo = reader.topology();
		expect(topo.providers).toEqual([
			{
				name: "pve",
				clusterMacId: 1,
				vmidMin: 500,
				vmidMax: 598,
				apiUrl: "https://pve.tail0000.ts.net:8006",
				tlsName: "pve",
				secretRef: "pve",
				nodes: [
					{
						name: "pve",
						ramCapMb: 8192,
						cloneConcurrency: 4,
						nodeAgentRef: "pve",
						storages: [
							{
								name: "local-lvm",
								driver: "lvmthin",
								dataMaxPct: 80,
								metaMaxPct: 70,
							},
						],
					},
				],
			},
		]);
		expect(topo.templateBuilds).toEqual([
			{
				templateSlug: "linux",
				version: "599-seed",
				os: "linux",
				node: "pve",
				storage: "local-lvm",
				pveVmid: 599,
				bootTimeoutS: 300,
				agentVersion: null,
				diskLayout: {},
				hw: {},
			},
		]);
	});
});

describe("StaticConfigReader.fromObject", () => {
	const base = () => ({
		templates: [
			{
				slug: "linux",
				os: "linux",
				defaultSize: "2gb",
				allowedSizes: ["2gb"],
			},
		],
		sizes: [{ slug: "2gb", vcpu: 2, memoryMb: 2048 }],
	});

	it("accepts a minimal config and fills defaults", async () => {
		const r = StaticConfigReader.fromObject(base());
		expect((await r.template("linux"))?.enabled).toBe(true);
		expect(await r.poolTargets()).toEqual([]);
		expect(await r.teamQuota("t")).toEqual({
			maxActiveSandboxes: 3,
			maxRamMb: 6144,
			maxSavedSnapshots: 10,
		});
		expect(r.topology()).toEqual({ providers: [], templateBuilds: [] });
	});

	it("lists every template (also disabled) and size in configuration order, as copies", async () => {
		const r = StaticConfigReader.fromObject({
			templates: [
				...base().templates,
				{
					slug: "win",
					os: "windows",
					enabled: false,
					defaultSize: "4gb",
					allowedSizes: ["4gb"],
				},
			],
			sizes: [...base().sizes, { slug: "4gb", vcpu: 2, memoryMb: 4096 }],
		});
		const list = await r.templates();
		expect(list.map((t) => [t.slug, t.enabled])).toEqual([
			["linux", true],
			["win", false],
		]);
		expect((await r.sizes()).map((s) => s.slug)).toEqual(["2gb", "4gb"]);
		list[0]?.allowedSizes.push("x");
		expect((await r.template("linux"))?.allowedSizes).toEqual(["2gb"]);
	});

	it("fills the S7 template and platform defaults (name, loginUser, capabilities, ports policy)", async () => {
		const r = StaticConfigReader.fromObject(base());
		const t = await r.template("linux");
		expect(t?.name).toBe("linux");
		expect(t?.loginUser).toBe("user");
		expect(t?.capabilities).toEqual(["exec", "files", "ssh"]);
		const d = await r.defaults();
		expect(d.publicPortsEnabled).toBe(true);
	});

	it("reads explicit S7 template and platform fields", async () => {
		const b = base();
		const r = StaticConfigReader.fromObject({
			...b,
			templates: [
				{
					...b.templates[0],
					name: "Ubuntu 26.04",
					loginUser: "admin",
					capabilities: ["exec", "files", "ssh", "desktop"],
				},
			],
			defaults: {
				publicPortsEnabled: false,
			},
		});
		expect(await r.template("linux")).toMatchObject({
			name: "Ubuntu 26.04",
			loginUser: "admin",
			capabilities: ["exec", "files", "ssh", "desktop"],
		});
		expect(await r.defaults()).toMatchObject({
			publicPortsEnabled: false,
			maxTtlSeconds: 604800,
		});

		// Capabilities are a closed set (S7 §13): a typo fails the config.
		expect(() =>
			StaticConfigReader.fromObject({
				...b,
				templates: [{ ...b.templates[0], capabilities: ["exec", "shh"] }],
			}),
		).toThrow(/capabilities/);
	});

	it("merges a per-team quota over the default", async () => {
		const r = StaticConfigReader.fromObject({
			...base(),
			quotas: {
				default: { maxActiveSandboxes: 2 },
				teams: { "team-1": { maxRamMb: 16384 } },
			},
		});
		expect(await r.teamQuota("team-1")).toEqual({
			maxActiveSandboxes: 2,
			maxRamMb: 16384,
			maxSavedSnapshots: 10,
		});
		expect((await r.teamQuota("other")).maxRamMb).toBe(6144);
	});

	it("reports the field path of an invalid value", () => {
		const bad = base();
		bad.sizes[0] = { slug: "2gb", vcpu: -1, memoryMb: 2048 };
		expect(() => StaticConfigReader.fromObject(bad)).toThrow(ConfigError);
		expect(() => StaticConfigReader.fromObject(bad)).toThrow(/sizes\.0\.vcpu/);
	});

	it("rejects an unknown os with its path", () => {
		const bad = base();
		bad.templates[0] = { ...bad.templates[0], os: "plan9" } as never;
		expect(() => StaticConfigReader.fromObject(bad)).toThrow(
			/templates\.0\.os/,
		);
	});

	it("rejects unknown keys", () => {
		expect(() =>
			StaticConfigReader.fromObject({ ...base(), quota: {} }),
		).toThrow(/quota/);
	});

	it("rejects defaultSize that is not in allowedSizes", () => {
		const bad = base();
		bad.sizes.push({ slug: "4gb", vcpu: 4, memoryMb: 4096 });
		bad.templates[0] = {
			slug: "linux",
			os: "linux",
			defaultSize: "4gb",
			allowedSizes: ["2gb"],
		};
		expect(() => StaticConfigReader.fromObject(bad)).toThrow(
			/templates\.0\.defaultSize/,
		);
	});

	it("rejects allowedSizes and pools that reference unknown entries", () => {
		const bad = base();
		bad.templates[0] = {
			slug: "linux",
			os: "linux",
			defaultSize: "2gb",
			allowedSizes: ["2gb", "8gb"],
		};
		expect(() => StaticConfigReader.fromObject(bad)).toThrow(
			/templates\.0\.allowedSizes\.1/,
		);
		expect(() =>
			StaticConfigReader.fromObject({
				...base(),
				pools: [{ templateSlug: "windows", sizeSlug: "2gb", target: 1 }],
			}),
		).toThrow(/pools\.0\.templateSlug/);
	});

	it("rejects duplicate template slugs", () => {
		const b = base();
		expect(() =>
			StaticConfigReader.fromObject({
				...b,
				templates: [...b.templates, ...b.templates],
			}),
		).toThrow(/templates\.1\.slug/);
	});
});

describe("StaticConfigReader.fromFile errors", () => {
	it("includes the field path for invalid YAML content", () => {
		const text = readFileSync(POC, "utf8").replace("vcpu: 2", "vcpu: two");
		const dir = path.dirname(POC);
		expect(() => StaticConfigReader.fromYaml(text, dir)).toThrow(
			/sizes\.0\.vcpu/,
		);
	});

	it("reports YAML syntax errors", () => {
		expect(() => StaticConfigReader.fromYaml("a: [1, 2", "inline")).toThrow(
			ConfigError,
		);
	});

	it("reports a missing file", () => {
		expect(() => StaticConfigReader.fromFile("/nonexistent/x.yaml")).toThrow(
			ConfigError,
		);
	});
});
