import type { ConfigReader } from "@sbx/config";
import type { JobSender, KeyRing } from "@sbx/core";
import type { Db } from "@sbx/db";
import type pg from "pg";
import { type DestinationStream, type Logger, pino } from "pino";
import type { IdpSync } from "./controllers/idp-sync.ts";
import type { AgentPort, GatewayPort, InfraRegistry } from "./ports.ts";

/** Poll intervals and limits of the step engine. Tests pass milliseconds. */
export interface Timing {
	/** Generic poll: boot wait, VM status. */
	pollMs: number;
	/** Fence re-check inside long waits (S6 §7.1: every 2 s). */
	supersedeCheckMs: number;
	/** Poll of the start gate while powered RAM is short (S6 §8.2: 1 s). */
	ramWaitPollMs: number;
	/** How long the start gate may wait before a retryable error. */
	ramWaitTimeoutMs: number;
	/** Poll for a free clone slot (S6 §8.3). */
	cloneSlotPollMs: number;
	/** How long to wait for a clone slot before a retryable error. */
	cloneSlotTimeoutMs: number;
	/** Agent connection wait where no template boot timeout applies. */
	agentConnectTimeoutMs?: number;
	/** Best-effort `System/PrepareStop` of a stop (S6 §7.5: 10 s). */
	prepareStopTimeoutMs?: number;
	/** S1 shutdown timeout of a stop before the hard stop (S6 §7.5: 60 s). */
	shutdownTimeoutS?: number;
}

export const DEFAULT_TIMING: Timing = {
	pollMs: 1000,
	supersedeCheckMs: 2000,
	ramWaitPollMs: 1000,
	ramWaitTimeoutMs: 300_000,
	cloneSlotPollMs: 1000,
	cloneSlotTimeoutMs: 300_000,
};

/** Metric sink. Task 13 backs it with prom-client; names follow S6 (`sbx_*`). */
export interface Metrics {
	inc(name: string, labels?: Record<string, string>, value?: number): void;
	set(name: string, value: number, labels?: Record<string, string>): void;
	observe(name: string, value: number, labels?: Record<string, string>): void;
}

export class NoopMetrics implements Metrics {
	inc(): void {}
	set(): void {}
	observe(): void {}
}

export interface RecordedMetric {
	kind: "inc" | "set" | "observe";
	name: string;
	value: number;
	labels: Record<string, string>;
}

/** Test double: keeps every call. */
export class RecordingMetrics implements Metrics {
	readonly calls: RecordedMetric[] = [];

	inc(name: string, labels: Record<string, string> = {}, value = 1): void {
		this.calls.push({ kind: "inc", name, value, labels });
	}
	set(name: string, value: number, labels: Record<string, string> = {}): void {
		this.calls.push({ kind: "set", name, value, labels });
	}
	observe(
		name: string,
		value: number,
		labels: Record<string, string> = {},
	): void {
		this.calls.push({ kind: "observe", name, value, labels });
	}
	count(name: string): number {
		return this.calls
			.filter((c) => c.name === name && c.kind === "inc")
			.reduce((n, c) => n + c.value, 0);
	}
}

export interface WorkerCtx {
	pool: pg.Pool;
	db: Db;
	jobs: JobSender;
	config: ConfigReader;
	keys: KeyRing;
	infra: InfraRegistry;
	agent: AgentPort;
	gateway: GatewayPort;
	timing: Timing;
	log: Logger;
	metrics: Metrics;
	/** S8 IdP sync; `ctl-idp-sync` is registered only when set (decision 15). */
	idpSync?: IdpSync;
}

/**
 * Secret-bearing fields (global constraints): env, secrets, secret files, the
 * bootstrap secret, tokens and the SMBIOS serial. Top level and one level down.
 */
export const REDACT_PATHS: string[] = [
	"env",
	"secrets",
	"secretEnv",
	"secretFiles",
	"bs",
	"token",
	"serial",
	"*.env",
	"*.secrets",
	"*.secretEnv",
	"*.secretFiles",
	"*.bs",
	"*.token",
	"*.serial",
];

export function createLogger(
	opts: { level?: string; name?: string } = {},
	destination?: DestinationStream,
): Logger {
	const options = {
		level: opts.level ?? "info",
		name: opts.name ?? "sbx-worker",
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
	};
	return destination ? pino(options, destination) : pino(options);
}
