export type TemplateOs = "linux" | "windows";

export interface TemplateConfig {
	slug: string;
	/** Display name; the slug when not set. */
	name: string;
	os: TemplateOs;
	enabled: boolean;
	defaultSize: string;
	allowedSizes: string[];
	/** Guest user of SSH logins (S7 §12.1); default `user`. */
	loginUser: string;
	/** S7 §13: `exec`, `files`, `ssh`, `desktop`; default `["exec", "files", "ssh"]`. */
	capabilities: string[];
}

export interface SizeConfig {
	slug: string;
	vcpu: number;
	memoryMb: number;
}

export interface PoolTarget {
	templateSlug: string;
	sizeSlug: string;
	providerId?: string;
	target: number;
	maxAgeHours?: number;
}

export interface Quota {
	maxActiveSandboxes: number;
	maxRamMb: number;
	maxSavedSnapshots: number;
}

export interface PlatformDefaults {
	ttlSeconds: number | null;
	maxTtlSeconds: number;
	idleTimeoutSeconds: number | null;
	stoppedRetentionDays: number | null;
	errorRetentionDays: number;
	recoverMinIntervalSeconds: number;
	defaultTemplate: string;
	/** `public` ports allowed (S7 §11.2); default true. */
	publicPortsEnabled: boolean;
	/** Who may open `sso` ports (S7 §7.7, S8 C7); default `any`. */
	ssoPortPolicy: SsoPortPolicy;
	/** Added to `auth_epoch` of `sso` routes; bumped on a policy change (S8 C7). */
	ssoPolicyEpoch: number;
}

export type SsoPortPolicy = "any" | "team";

/** S6 §5.11. Implementations: StaticConfigReader (YAML), PayloadConfigReader (S8). */
export interface ConfigReader {
	template(slug: string): Promise<TemplateConfig | null>;
	size(slug: string): Promise<SizeConfig | null>;
	poolTargets(): Promise<PoolTarget[]>;
	/** Unknown teams get the default quota. */
	teamQuota(teamId: string): Promise<Quota>;
	defaults(): Promise<PlatformDefaults>;
}

export interface StorageTopology {
	name: string;
	driver: "lvmthin";
	dataMaxPct: number;
	metaMaxPct: number;
}

export interface NodeTopology {
	name: string;
	ramCapMb: number;
	cloneConcurrency: number;
	nodeAgentRef: string;
	storages: StorageTopology[];
}

export interface ProviderTopology {
	name: string;
	clusterMacId: number;
	vmidMin: number;
	vmidMax: number;
	apiUrl: string;
	tlsName: string | null;
	secretRef: string;
	nodes: NodeTopology[];
}

export interface TemplateBuildTopology {
	templateSlug: string;
	version: string;
	os: TemplateOs;
	node: string;
	storage: string;
	pveVmid: number;
	bootTimeoutS: number;
	/** Null for a seeded pre-S5 template. */
	agentVersion: string | null;
	diskLayout: Record<string, unknown>;
	hw: Record<string, unknown>;
}

/** Environment data that `sbx-admin bootstrap` writes to the database. */
export interface TopologyConfig {
	providers: ProviderTopology[];
	templateBuilds: TemplateBuildTopology[];
}
