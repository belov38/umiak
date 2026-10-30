import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
	ConfigReader,
	PlatformDefaults,
	PoolTarget,
	Quota,
	SizeConfig,
	TemplateConfig,
	TopologyConfig,
} from "./types.ts";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const slug = z.string().min(1);
const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();
const os = z.enum(["linux", "windows"]);

/** Capabilities of a template (S7 §13); a typo in the config fails the load. */
export const TEMPLATE_CAPABILITIES = [
	"exec",
	"files",
	"ssh",
	"desktop",
] as const;
const DEFAULT_CAPABILITIES: (typeof TEMPLATE_CAPABILITIES)[number][] = [
	"exec",
	"files",
	"ssh",
];

const templateSchema = z
	.strictObject({
		slug,
		name: z.string().min(1).optional(),
		os,
		enabled: z.boolean().default(true),
		defaultSize: slug,
		allowedSizes: z.array(slug).min(1),
		loginUser: z.string().min(1).default("user"),
		capabilities: z
			.array(z.enum(TEMPLATE_CAPABILITIES))
			.default(() => [...DEFAULT_CAPABILITIES]),
	})
	.transform(
		(t): TemplateConfig => ({
			slug: t.slug,
			name: t.name ?? t.slug,
			os: t.os,
			enabled: t.enabled,
			defaultSize: t.defaultSize,
			allowedSizes: t.allowedSizes,
			loginUser: t.loginUser,
			capabilities: t.capabilities,
		}),
	);

const sizeSchema = z.strictObject({
	slug,
	vcpu: posInt,
	memoryMb: posInt,
});

const poolSchema = z.strictObject({
	templateSlug: slug,
	sizeSlug: slug,
	providerId: z.string().min(1).optional(),
	target: nonNegInt,
	maxAgeHours: posInt.optional(),
});

const quotaFields = {
	maxActiveSandboxes: nonNegInt,
	maxRamMb: nonNegInt,
	maxSavedSnapshots: nonNegInt,
};

// PoC quota (S8): 3 sandboxes, 6 GB of RAM, 10 saved snapshots.
const DEFAULT_QUOTA: Quota = {
	maxActiveSandboxes: 3,
	maxRamMb: 6144,
	maxSavedSnapshots: 10,
};

const quotasSchema = z
	.strictObject({
		default: z.strictObject(quotaFields).partial().default({}),
		teams: z
			.record(z.string(), z.strictObject(quotaFields).partial())
			.default({}),
	})
	.default({ default: {}, teams: {} });

// S6 §5.11 defaults.
const defaultsSchema = z
	.strictObject({
		ttlSeconds: posInt.nullable().default(null),
		maxTtlSeconds: posInt.default(604800),
		idleTimeoutSeconds: posInt.nullable().default(900),
		stoppedRetentionDays: posInt.nullable().default(null),
		errorRetentionDays: posInt.default(7),
		recoverMinIntervalSeconds: nonNegInt.default(600),
		defaultTemplate: slug.default("linux"),
		publicPortsEnabled: z.boolean().default(true),
		ssoPortPolicy: z.enum(["any", "team"]).default("any"),
		ssoPolicyEpoch: nonNegInt.default(0),
	})
	.default({
		ttlSeconds: null,
		maxTtlSeconds: 604800,
		idleTimeoutSeconds: 900,
		stoppedRetentionDays: null,
		errorRetentionDays: 7,
		recoverMinIntervalSeconds: 600,
		defaultTemplate: "linux",
		publicPortsEnabled: true,
		ssoPortPolicy: "any",
		ssoPolicyEpoch: 0,
	});

const pct = z.number().int().min(1).max(100);

const storageSchema = z.strictObject({
	name: slug,
	driver: z.enum(["lvmthin"]).default("lvmthin"),
	dataMaxPct: pct.default(80),
	metaMaxPct: pct.default(70),
});

const nodeSchema = z.strictObject({
	name: slug,
	ramCapMb: nonNegInt,
	cloneConcurrency: posInt.default(4),
	nodeAgentRef: slug,
	storages: z.array(storageSchema).default([]),
});

const providerSchema = z
	.strictObject({
		name: slug,
		clusterMacId: z.number().int().min(0).max(255),
		vmidMin: posInt,
		vmidMax: posInt,
		apiUrl: z.url(),
		tlsName: z.string().min(1).nullable().default(null),
		secretRef: slug,
		nodes: z.array(nodeSchema).default([]),
	})
	.refine((p) => p.vmidMin <= p.vmidMax, {
		path: ["vmidMax"],
		message: "vmidMax must be >= vmidMin",
	});

const templateBuildSchema = z.strictObject({
	templateSlug: slug,
	version: slug,
	os,
	node: slug,
	storage: slug,
	pveVmid: posInt,
	bootTimeoutS: posInt,
	agentVersion: z.string().min(1).nullable().default(null),
	diskLayout: z.record(z.string(), z.unknown()).default({}),
	hw: z.record(z.string(), z.unknown()).default({}),
});

const topologySchema = z
	.strictObject({
		providers: z.array(providerSchema).default([]),
		templateBuilds: z.array(templateBuildSchema).default([]),
	})
	.default({ providers: [], templateBuilds: [] });

const configSchema = z
	.strictObject({
		templates: z.array(templateSchema).default([]),
		sizes: z.array(sizeSchema).default([]),
		pools: z.array(poolSchema).default([]),
		quotas: quotasSchema,
		defaults: defaultsSchema,
		topology: topologySchema,
	})
	.superRefine((cfg, ctx) => {
		const sizes = new Set<string>();
		cfg.sizes.forEach((s, i) => {
			if (sizes.has(s.slug)) {
				ctx.addIssue({
					code: "custom",
					path: ["sizes", i, "slug"],
					message: `duplicate size "${s.slug}"`,
				});
			}
			sizes.add(s.slug);
		});
		const templates = new Set<string>();
		cfg.templates.forEach((t, i) => {
			if (templates.has(t.slug)) {
				ctx.addIssue({
					code: "custom",
					path: ["templates", i, "slug"],
					message: `duplicate template "${t.slug}"`,
				});
			}
			templates.add(t.slug);
			t.allowedSizes.forEach((s, j) => {
				if (!sizes.has(s)) {
					ctx.addIssue({
						code: "custom",
						path: ["templates", i, "allowedSizes", j],
						message: `unknown size "${s}"`,
					});
				}
			});
			if (!t.allowedSizes.includes(t.defaultSize)) {
				ctx.addIssue({
					code: "custom",
					path: ["templates", i, "defaultSize"],
					message: `defaultSize "${t.defaultSize}" is not in allowedSizes`,
				});
			}
		});
		cfg.pools.forEach((p, i) => {
			if (!templates.has(p.templateSlug)) {
				ctx.addIssue({
					code: "custom",
					path: ["pools", i, "templateSlug"],
					message: `unknown template "${p.templateSlug}"`,
				});
			}
			if (!sizes.has(p.sizeSlug)) {
				ctx.addIssue({
					code: "custom",
					path: ["pools", i, "sizeSlug"],
					message: `unknown size "${p.sizeSlug}"`,
				});
			}
		});
	});

type ParsedConfig = z.output<typeof configSchema>;

function mergeQuota(
	base: Quota,
	over: { [K in keyof Quota]?: number | undefined },
): Quota {
	return {
		maxActiveSandboxes: over.maxActiveSandboxes ?? base.maxActiveSandboxes,
		maxRamMb: over.maxRamMb ?? base.maxRamMb,
		maxSavedSnapshots: over.maxSavedSnapshots ?? base.maxSavedSnapshots,
	};
}

function formatIssues(source: string, err: z.ZodError): string {
	const lines = err.issues.map((i) => {
		const where = i.path.length > 0 ? i.path.join(".") : "(root)";
		return `  ${where}: ${i.message}`;
	});
	return `invalid config ${source}:\n${lines.join("\n")}`;
}

/** Configuration from a YAML file (SBX_CONFIG_FILE). Used until the Payload reader (S8) exists. */
export class StaticConfigReader implements ConfigReader {
	readonly #templates: Map<string, TemplateConfig>;
	readonly #sizes: Map<string, SizeConfig>;
	readonly #pools: PoolTarget[];
	readonly #defaultQuota: Quota;
	readonly #teamQuotas: Map<string, Quota>;
	readonly #defaults: PlatformDefaults;
	readonly #topology: TopologyConfig;

	private constructor(cfg: ParsedConfig) {
		this.#templates = new Map(cfg.templates.map((t) => [t.slug, t]));
		this.#sizes = new Map(cfg.sizes.map((s) => [s.slug, s]));
		this.#pools = cfg.pools.map((p) => ({
			templateSlug: p.templateSlug,
			sizeSlug: p.sizeSlug,
			target: p.target,
			...(p.providerId !== undefined ? { providerId: p.providerId } : {}),
			...(p.maxAgeHours !== undefined ? { maxAgeHours: p.maxAgeHours } : {}),
		}));
		this.#defaultQuota = mergeQuota(DEFAULT_QUOTA, cfg.quotas.default);
		this.#teamQuotas = new Map(
			Object.entries(cfg.quotas.teams).map(([id, q]) => [
				id,
				mergeQuota(this.#defaultQuota, q),
			]),
		);
		this.#defaults = cfg.defaults;
		this.#topology = cfg.topology;
	}

	static fromObject(obj: unknown, source = "config"): StaticConfigReader {
		const res = configSchema.safeParse(obj ?? {});
		if (!res.success) throw new ConfigError(formatIssues(source, res.error));
		return new StaticConfigReader(res.data);
	}

	static fromYaml(text: string, source = "config"): StaticConfigReader {
		let doc: unknown;
		try {
			doc = parseYaml(text);
		} catch (err) {
			throw new ConfigError(
				`invalid YAML in ${source}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return StaticConfigReader.fromObject(doc, source);
	}

	static fromFile(path: string): StaticConfigReader {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			throw new ConfigError(
				`cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return StaticConfigReader.fromYaml(text, path);
	}

	async template(slug: string): Promise<TemplateConfig | null> {
		return this.#templates.get(slug) ?? null;
	}

	async size(slug: string): Promise<SizeConfig | null> {
		return this.#sizes.get(slug) ?? null;
	}

	async templates(): Promise<TemplateConfig[]> {
		return [...this.#templates.values()].map((t) => ({
			...t,
			allowedSizes: [...t.allowedSizes],
			capabilities: [...t.capabilities],
		}));
	}

	async sizes(): Promise<SizeConfig[]> {
		return [...this.#sizes.values()].map((s) => ({ ...s }));
	}

	async poolTargets(): Promise<PoolTarget[]> {
		return this.#pools.map((p) => ({ ...p }));
	}

	async teamQuota(teamId: string): Promise<Quota> {
		return { ...(this.#teamQuotas.get(teamId) ?? this.#defaultQuota) };
	}

	async defaults(): Promise<PlatformDefaults> {
		return { ...this.#defaults };
	}

	topology(): TopologyConfig {
		return this.#topology;
	}
}
