// Drizzle description of schema `runtime` (S6 §5.1-5.9, §8.3). The SQL in
// db/migrations/02xx_*.sql and 0400_*.sql is the source of truth; test/schema-drift.test.ts
// checks that every column, type and nullability here matches it.
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	smallint,
	text,
	uuid,
} from "drizzle-orm/pg-core";
import { bytea, tstz } from "./types.ts";

export const runtime = pgSchema("runtime");

export const PROVIDER_STATES = ["active", "draining", "disabled"] as const;
export const NODE_STATES = ["active", "cordoned", "down"] as const;
export const TEMPLATE_BUILD_STATUSES = [
	"building",
	"active",
	"deprecated",
	"retired",
] as const;
export const OS_KINDS = ["linux", "windows"] as const;
export const LEASE_STATES = ["reserved", "active", "releasing"] as const;
export const LEASE_PURPOSES = ["machine", "template"] as const;
export const MACHINE_STATES = [
	"allocating",
	"provisioning",
	"booting",
	"warm",
	"claiming",
	"running",
	"stopping",
	"stopped",
	"starting",
	"failed",
	"deleting",
	"deleted",
] as const;
export const MACHINE_ORIGINS = ["template", "snapshot"] as const;
export const POWER_STATES = [
	"running",
	"stopped",
	"paused",
	"unknown",
] as const;
export const DISK_SLOTS = ["efidisk0", "scsi0", "tpmstate0"] as const;
export const DISK_STATES = ["active", "deleting", "deleted"] as const;
export const SNAPSHOT_KINDS = ["auto", "saved", "fork_source"] as const;
export const SNAPSHOT_CONSISTENCIES = [
	"quiesced",
	"crash",
	"powered_off",
] as const;
export const SNAPSHOT_STATES = [
	"creating",
	"ready",
	"failed",
	"deleting",
	"deleted",
] as const;
export const SANDBOX_STATES = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
	"deleted",
] as const;
export const SANDBOX_ORIGINS = ["template", "snapshot", "fork"] as const;
export const STOP_REASONS = [
	"user",
	"ttl",
	"idle",
	"unexpected_shutdown",
	"retention",
] as const;
export const HEALTH_STATES = ["ok", "degraded"] as const;
export const ACTIVITY_STATES = ["busy", "idle", "unknown"] as const;
export const OPERATION_KINDS = [
	"create",
	"fork",
	"stop",
	"resume",
	"recover",
	"delete",
	"save_snapshot",
	"reprovision",
] as const;
export const OPERATION_STATES = [
	"pending",
	"running",
	"succeeded",
	"failed",
	"superseded",
] as const;
export const COMMAND_MODES = ["sync", "stream", "detached", "pty"] as const;
export const COMMAND_STATUSES = [
	"starting",
	"running",
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
] as const;
/** S3 `ExitReason` in lower case (S7 §9.6). */
export const COMMAND_EXIT_REASONS = [
	"none",
	"signal",
	"timeout",
	"oom",
	"pty_idle",
	"reboot",
	"shim_lost",
	"start_failed",
] as const;
export const PORT_MODES = ["token", "sso", "public"] as const;
export const PORT_HOST_REWRITES = ["preserve", "localhost"] as const;
export const PORT_APP_PROTOCOLS = ["http1", "h2c"] as const;

const createdAt = () => tstz("created_at").notNull().defaultNow();
const updatedAt = () => tstz("updated_at").notNull().defaultNow();
const version = () => integer("version").notNull().default(0);
// DEFAULT uuidv7() mirrors the SQL; ids are normally generated in code (decision 3).
const pk = () => uuid("id").primaryKey().default(sql`uuidv7()`);

// §5.1 Topology

export const providers = runtime.table("providers", {
	id: pk(),
	kind: text("kind", { enum: ["proxmox"] }).notNull(),
	name: text("name").notNull(),
	clusterMacId: smallint("cluster_mac_id").notNull(),
	vmidMin: integer("vmid_min").notNull(),
	vmidMax: integer("vmid_max").notNull(),
	apiUrl: text("api_url").notNull(),
	tlsName: text("tls_name"),
	secretRef: text("secret_ref").notNull(),
	state: text("state", { enum: PROVIDER_STATES }).notNull().default("active"),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const nodes = runtime.table("nodes", {
	id: pk(),
	providerId: uuid("provider_id").notNull(),
	name: text("name").notNull(),
	state: text("state", { enum: NODE_STATES }).notNull().default("active"),
	ramCapMb: integer("ram_cap_mb").notNull(),
	cloneConcurrency: integer("clone_concurrency").notNull().default(4),
	nodeAgentRef: text("node_agent_ref").notNull(),
	mediaStorage: text("media_storage").notNull().default("local"),
	retiredAt: tstz("retired_at"),
	lastSeenAt: tstz("last_seen_at"),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const storages = runtime.table("storages", {
	id: pk(),
	providerId: uuid("provider_id").notNull(),
	nodeId: uuid("node_id"),
	name: text("name").notNull(),
	driver: text("driver", { enum: ["lvmthin"] }).notNull(),
	dataMaxPct: integer("data_max_pct").notNull().default(80),
	metaMaxPct: integer("meta_max_pct").notNull().default(70),
	usage: jsonb("usage"),
	usageAt: tstz("usage_at"),
});

// §5.2 Template builds

export const templateBuilds = runtime.table("template_builds", {
	id: pk(),
	templateSlug: text("template_slug").notNull(),
	version: text("version").notNull(),
	os: text("os", { enum: OS_KINDS }).notNull(),
	providerId: uuid("provider_id").notNull(),
	nodeId: uuid("node_id").notNull(),
	storageId: uuid("storage_id").notNull(),
	pveVmid: integer("pve_vmid").notNull(),
	headless: boolean("headless").default(false),
	diskLayout: jsonb("disk_layout").notNull(),
	hw: jsonb("hw").notNull(),
	agentVersion: text("agent_version"),
	bootTimeoutS: integer("boot_timeout_s").notNull(),
	status: text("status", { enum: TEMPLATE_BUILD_STATUSES })
		.notNull()
		.default("building"),
	createdAt: createdAt(),
	promotedAt: tstz("promoted_at"),
});

// §5.3 Allocator

export const vmidLeases = runtime.table(
	"vmid_leases",
	{
		providerId: uuid("provider_id").notNull(),
		vmid: integer("vmid").notNull(),
		mac: text("mac").notNull(),
		state: text("state", { enum: LEASE_STATES }).notNull(),
		purpose: text("purpose", { enum: LEASE_PURPOSES }).notNull(),
		machineId: uuid("machine_id"),
		buildJobId: text("build_job_id").references(() => nodeBuildJobs.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [primaryKey({ columns: [t.providerId, t.vmid] })],
);

// §5.4 Machines and disks

export const machines = runtime.table("machines", {
	id: pk(),
	providerId: uuid("provider_id").notNull(),
	nodeId: uuid("node_id").notNull(),
	storageId: uuid("storage_id").notNull(),
	vmid: integer("vmid"),
	mac: text("mac"),
	templateBuildId: uuid("template_build_id").notNull(),
	origin: text("origin", { enum: MACHINE_ORIGINS }).notNull(),
	originSnapshotId: uuid("origin_snapshot_id"),
	poolKey: text("pool_key"),
	sizeSlug: text("size_slug").notNull(),
	vcpu: integer("vcpu").notNull(),
	memoryMb: integer("memory_mb").notNull(),
	sandboxId: uuid("sandbox_id"),
	state: text("state", { enum: MACHINE_STATES }).notNull(),
	powerObserved: text("power_observed", { enum: POWER_STATES })
		.notNull()
		.default("unknown"),
	powerObservedAt: tstz("power_observed_at"),
	unexpectedStops: jsonb("unexpected_stops")
		.$type<string[]>()
		.notNull()
		.default([]),
	provisionedBootId: text("provisioned_boot_id"),
	secretFilesOnDisk: boolean("secret_files_on_disk").notNull().default(false),
	cleanStop: boolean("clean_stop").notNull().default(false),
	secretsGeneration: integer("secrets_generation").notNull().default(0),
	provisionedSecretsGeneration: integer("provisioned_secrets_generation")
		.notNull()
		.default(0),
	readyBootId: text("ready_boot_id"),
	agentPhase: text("agent_phase"),
	execAttempt: integer("exec_attempt").notNull().default(0),
	errorCode: text("error_code"),
	errorDetail: text("error_detail"),
	createdAt: createdAt(),
	warmAt: tstz("warm_at"),
	claimedAt: tstz("claimed_at"),
	deletedAt: tstz("deleted_at"),
	stateChangedAt: tstz("state_changed_at").notNull().defaultNow(),
	version: version(),
});

export const disks = runtime.table("disks", {
	id: pk(),
	machineId: uuid("machine_id"),
	snapshotId: uuid("snapshot_id"),
	storageId: uuid("storage_id").notNull(),
	slot: text("slot", { enum: DISK_SLOTS }).notNull(),
	volume: text("volume").notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	options: jsonb("options")
		.$type<Record<string, string>>()
		.notNull()
		.default({}),
	state: text("state", { enum: DISK_STATES }).notNull().default("active"),
	createdAt: createdAt(),
	deletedAt: tstz("deleted_at"),
});

// §5.5 Snapshots

export const snapshots = runtime.table("snapshots", {
	id: pk(),
	kind: text("kind", { enum: SNAPSHOT_KINDS }).notNull(),
	teamId: uuid("team_id").notNull(),
	name: text("name"),
	pendingName: text("pending_name"),
	sourceSandboxId: uuid("source_sandbox_id"),
	sourceMachineId: uuid("source_machine_id"),
	consumerSandboxId: uuid("consumer_sandbox_id"),
	providerId: uuid("provider_id").notNull(),
	nodeId: uuid("node_id").notNull(),
	storageId: uuid("storage_id").notNull(),
	templateBuildId: uuid("template_build_id").notNull(),
	/** LV id: the snapshot UUID without dashes, 32 hex (decision 2). */
	lvId: text("lv_id").notNull(),
	hw: jsonb("hw").$type<Record<string, string>>(),
	consistency: text("consistency", { enum: SNAPSHOT_CONSISTENCIES }),
	quiesceBroken: boolean("quiesce_broken").notNull().default(false),
	state: text("state", { enum: SNAPSHOT_STATES }).notNull().default("creating"),
	createdAt: createdAt(),
	readyAt: tstz("ready_at"),
	deletedAt: tstz("deleted_at"),
	version: version(),
});

// §5.6 Sandboxes

export const sandboxes = runtime.table("sandboxes", {
	id: pk(),
	slug: text("slug").notNull(),
	teamId: uuid("team_id").notNull(),
	createdBy: uuid("created_by"),
	createdByKey: uuid("created_by_key"),
	name: text("name"),
	labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
	templateSlug: text("template_slug").notNull(),
	sizeSlug: text("size_slug").notNull(),
	vcpu: integer("vcpu").notNull(),
	memoryMb: integer("memory_mb").notNull(),
	templateBuildId: uuid("template_build_id").notNull(),
	origin: text("origin", { enum: SANDBOX_ORIGINS }).notNull(),
	originSnapshotId: uuid("origin_snapshot_id"),
	forkedFromSandboxId: uuid("forked_from_sandbox_id"),
	providerId: uuid("provider_id"),
	nodeId: uuid("node_id"),
	machineId: uuid("machine_id"),
	state: text("state", { enum: SANDBOX_STATES }).notNull(),
	stopReason: text("stop_reason", { enum: STOP_REASONS }),
	health: text("health", { enum: HEALTH_STATES }).notNull().default("ok"),
	healthReason: text("health_reason"),
	degradedSince: tstz("degraded_since"),
	activity: text("activity", { enum: ACTIVITY_STATES })
		.notNull()
		.default("unknown"),
	activityCounters: jsonb("activity_counters").$type<{
		runningCommands: number;
		openPtys: number;
		tcpStreams: number;
	}>(),
	lastActivityAt: tstz("last_activity_at"),
	/** Since when the counters are all zero (idle-stop, S6 §12; migration 0202). */
	activityZeroSince: tstz("activity_zero_since"),
	lastApiCallAt: tstz("last_api_call_at"),
	ttlSeconds: integer("ttl_seconds"),
	deadlineAt: tstz("deadline_at"),
	idleTimeoutSeconds: integer("idle_timeout_seconds"),
	lastRebootAt: tstz("last_reboot_at"),
	lastRebootReason: text("last_reboot_reason"),
	lastRecoverAt: tstz("last_recover_at"),
	errorCode: text("error_code"),
	errorMessage: text("error_message"),
	/** Last ports.changed snapshot from the agent (S7 §20.2 item 8). */
	listeningPorts: jsonb("listening_ports"),
	createdAt: createdAt(),
	readyAt: tstz("ready_at"),
	stoppedAt: tstz("stopped_at"),
	deletedAt: tstz("deleted_at"),
	stateChangedAt: tstz("state_changed_at").notNull().defaultNow(),
	version: version(),
	/** Operator block (S8; migration 0204): every port of the sandbox is blocked. */
	blocked: boolean("blocked").notNull().default(false),
	blockReason: text("block_reason"),
	/** When and by which operator (migration 0206). */
	blockedAt: tstz("blocked_at"),
	blockedBy: uuid("blocked_by"),
	/** Last change of the row, set by a trigger (migration 0205). */
	updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const sandboxSecrets = runtime.table("sandbox_secrets", {
	sandboxId: uuid("sandbox_id").primaryKey(),
	keyVersion: integer("key_version").notNull(),
	nonce: bytea("nonce").notNull(),
	ciphertext: bytea("ciphertext").notNull(),
	updatedAt: updatedAt(),
});

export const sandboxEvents = runtime.table("sandbox_events", {
	id: pk(),
	sandboxId: uuid("sandbox_id").notNull(),
	type: text("type").notNull(),
	fromState: text("from_state"),
	toState: text("to_state"),
	reason: text("reason"),
	data: jsonb("data"),
	createdAt: createdAt(),
});

// §5.7 Operations and idempotency

export const operations = runtime.table("operations", {
	id: pk(),
	sandboxId: uuid("sandbox_id").notNull(),
	kind: text("kind", { enum: OPERATION_KINDS }).notNull(),
	state: text("state", { enum: OPERATION_STATES }).notNull().default("pending"),
	request: jsonb("request")
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	step: text("step"),
	progress: jsonb("progress")
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	attempt: integer("attempt").notNull().default(0),
	errorCode: text("error_code"),
	errorMessage: text("error_message"),
	retryable: boolean("retryable"),
	requestedBy: uuid("requested_by"),
	requestedByKey: uuid("requested_by_key"),
	parentOperationId: uuid("parent_operation_id"),
	supersededBy: uuid("superseded_by"),
	/** Null for delete, which has no deadline (§7.9). */
	deadlineAt: tstz("deadline_at"),
	createdAt: createdAt(),
	startedAt: tstz("started_at"),
	finishedAt: tstz("finished_at"),
	version: version(),
});

export const idempotencyKeys = runtime.table(
	"idempotency_keys",
	{
		principalId: uuid("principal_id").notNull(),
		key: text("key").notNull(),
		scope: text("scope").notNull(),
		requestHash: bytea("request_hash").notNull(),
		operationId: uuid("operation_id"),
		sandboxId: uuid("sandbox_id"),
		response: jsonb("response"),
		createdAt: createdAt(),
		expiresAt: tstz("expires_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.principalId, t.scope, t.key] })],
);

// §5.8 Commands and ports

export const commands = runtime.table("commands", {
	/** ULID, = commandId of Process/Start (S2). */
	id: text("id").primaryKey(),
	sandboxId: uuid("sandbox_id").notNull(),
	machineId: uuid("machine_id").notNull(),
	cmd: text("cmd").notNull(),
	cwd: text("cwd"),
	envKeys: text("env_keys").array().notNull().default([]),
	mode: text("mode", { enum: COMMAND_MODES }).notNull(),
	timeoutSeconds: integer("timeout_seconds"),
	status: text("status", { enum: COMMAND_STATUSES })
		.notNull()
		.default("starting"),
	exitCode: integer("exit_code"),
	signal: text("signal"),
	stdoutBytes: bigint("stdout_bytes", { mode: "number" }),
	stderrBytes: bigint("stderr_bytes", { mode: "number" }),
	bootId: text("boot_id"),
	createdBy: uuid("created_by"),
	requestId: text("request_id"),
	createdAt: createdAt(),
	startedAt: tstz("started_at"),
	endedAt: tstz("ended_at"),
	// S7 §9.6 (migration 0204).
	user: text("user").notNull().default("user"),
	tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
	argv: jsonb("argv").$type<string[]>(),
	pid: integer("pid"),
	/** The team key that started the command (S7 §20.2 item 9). */
	createdByKey: uuid("created_by_key"),
	// S7 §9.6, §23.3 (migration 0304, S7 range).
	reason: text("reason", { enum: COMMAND_EXIT_REASONS }),
	/** "disk_full" when the agent dropped output; null otherwise. */
	outputTruncated: text("output_truncated"),
});

export const hostedPorts = runtime.table("hosted_ports", {
	id: pk(),
	sandboxId: uuid("sandbox_id").notNull(),
	port: integer("port").notNull(),
	label: text("label").notNull(),
	mode: text("mode", { enum: PORT_MODES }).notNull(),
	tokenHash: bytea("token_hash"),
	authEpoch: integer("auth_epoch").notNull().default(0),
	createdAt: createdAt(),
	deletedAt: tstz("deleted_at"),
	// S7 §11.2, S8 operator blocks (migration 0204).
	hostRewrite: text("host_rewrite", { enum: PORT_HOST_REWRITES })
		.notNull()
		.default("preserve"),
	appProtocol: text("app_protocol", { enum: PORT_APP_PROTOCOLS })
		.notNull()
		.default("http1"),
	blocked: boolean("blocked").notNull().default(false),
	blockReason: text("block_reason"),
	/** When and by which operator (migration 0206). */
	blockedAt: tstz("blocked_at"),
	blockedBy: uuid("blocked_by"),
});

// §5.9 Agent events

export const agentEvents = runtime.table(
	"agent_events",
	{
		machineId: uuid("machine_id").notNull(),
		seq: bigint("seq", { mode: "number" }).notNull(),
		bootId: text("boot_id").notNull(),
		type: text("type").notNull(),
		time: tstz("time").notNull(),
		payload: jsonb("payload")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		receivedAt: tstz("received_at").notNull().defaultNow(),
		processedAt: tstz("processed_at"),
	},
	(t) => [primaryKey({ columns: [t.machineId, t.seq] })],
);

export const agentSyntheticEvents = runtime.table(
	"agent_synthetic_events",
	{
		machineId: uuid("machine_id").notNull(),
		epoch: bigint("epoch", { mode: "number" }).notNull(),
		type: text("type").notNull(),
		instanceId: text("instance_id").notNull(),
		time: tstz("time").notNull(),
		receivedAt: tstz("received_at").notNull().defaultNow(),
		processedAt: tstz("processed_at"),
	},
	(t) => [primaryKey({ columns: [t.machineId, t.epoch, t.type] })],
);

// §8.3 Clone slots

export const nodeCloneSlots = runtime.table(
	"node_clone_slots",
	{
		nodeId: uuid("node_id").notNull(),
		slot: integer("slot").notNull(),
		holder: text("holder"),
		expiresAt: tstz("expires_at"),
	},
	(t) => [primaryKey({ columns: [t.nodeId, t.slot] })],
);

// §11.2 Reconcile: first sighting of a VM or LV (grace for fresh objects)

export const RECONCILE_SEEN_KINDS = ["vm", "lv"] as const;

export const reconcileSeen = runtime.table(
	"reconcile_seen",
	{
		providerId: uuid("provider_id").notNull(),
		kind: text("kind", { enum: RECONCILE_SEEN_KINDS }).notNull(),
		/** '<node_id>/<vmid>' or '<node_id>/<lv name>'. */
		name: text("name").notNull(),
		firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.providerId, t.kind, t.name] })],
);

// One-time port SSO codes (S7 §7.7, §12.2; migration 0301).
export const portAuthCodes = runtime.table("port_auth_codes", {
	/** sha256 of the 32-byte code. */
	codeHash: bytea("code_hash").primaryKey(),
	label: text("label").notNull(),
	userId: text("user_id").notNull(),
	email: text("email").notNull(),
	authEpoch: integer("auth_epoch").notNull(),
	expiresAt: tstz("expires_at").notNull(),
	usedAt: tstz("used_at"),
	createdAt: tstz("created_at").notNull().defaultNow(),
});

// Team environments (S8 §10.3; migration 0400). team_id and updated_by are
// plain uuids: teams and users live in the Payload schema. The sets are an
// AES-256-GCM blob (AAD `environment:<id>:v<key_version>`).
export const environments = runtime.table("environments", {
	id: uuid("id").primaryKey().default(sql`uuidv7()`),
	teamId: uuid("team_id").notNull(),
	name: text("name").notNull(),
	isDefault: boolean("is_default").notNull().default(false),
	revision: integer("revision").notNull().default(1),
	keyVersion: integer("key_version").notNull(),
	nonce: bytea("nonce").notNull(),
	ciphertext: bytea("ciphertext").notNull(),
	repositories: jsonb("repositories").notNull().default(sql`'[]'::jsonb`),
	excludeOwnerSecrets: boolean("exclude_owner_secrets")
		.notNull()
		.default(false),
	createdAt: tstz("created_at").notNull().defaultNow(),
	updatedAt: tstz("updated_at").notNull().defaultNow(),
	updatedBy: uuid("updated_by"),
});

// S10 policy and single-use ticket state (migrations 0401-0405).
export const sandboxDesktops = runtime.table("sandbox_desktops", {
	sandboxId: uuid("sandbox_id")
		.primaryKey()
		.references(() => sandboxes.id, { onDelete: "cascade" }),
	access: text("access", { enum: ["token", "sso", "public"] })
		.notNull()
		.default("token"),
	authEpoch: integer("auth_epoch").notNull().default(1),
	turnIssuedAt: tstz("turn_issued_at"),
	turnAttemptedAt: tstz("turn_attempted_at"),
	lastStopOperationId: uuid("last_stop_operation_id"),
	updatedAt: tstz("updated_at").notNull().defaultNow(),
	pendingDisconnect: boolean("pending_disconnect").notNull().default(false),
	policyRevoked: boolean("policy_revoked").notNull().default(false),
});
export const desktopTickets = runtime.table("desktop_tickets", {
	ticketHash: bytea("ticket_hash").primaryKey(),
	sandboxId: uuid("sandbox_id")
		.notNull()
		.references(() => sandboxDesktops.sandboxId, { onDelete: "cascade" }),
	label: text("label").notNull(),
	userId: text("user_id"),
	apiKeyId: text("api_key_id"),
	authEpoch: integer("auth_epoch").notNull(),
	expiresAt: tstz("expires_at").notNull(),
	usedAt: tstz("used_at"),
	createdAt: tstz("created_at").notNull().defaultNow(),
});

// S19 durable node-local build reservations; interruption keeps admission fenced.
export const nodeBuildJobs = runtime.table("node_build_jobs", {
	id: text("id").primaryKey(),
	nodeId: uuid("node_id").notNull(),
	templateSlug: text("template_slug").notNull(),
	status: text("status", {
		enum: ["running", "interrupted", "succeeded", "failed"],
	})
		.notNull()
		.default("running"),
	createdAt: createdAt(),
	finishedAt: tstz("finished_at"),
});
