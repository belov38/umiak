// Worker process fixtures: startWorker options over fakes, and small polls.
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { StaticConfigReader } from "@sbx/config";
import { KeyRing } from "@sbx/core";
import type pg from "pg";
import { createLogger } from "../../src/context.ts";
import type { InfraRegistry } from "../../src/ports.ts";
import type { WorkerOptions } from "../../src/worker.ts";
import { FakeAgent } from "../fakes/agent.ts";
import { FakeGateway } from "../fakes/gateway.ts";
import { TEST_TIMING } from "../fakes/world.ts";

export function testConfig(templateSlug: string): StaticConfigReader {
	return StaticConfigReader.fromObject({
		templates: [
			{
				slug: templateSlug,
				os: "linux",
				enabled: true,
				defaultSize: "2gb",
				allowedSizes: ["2gb"],
			},
		],
		sizes: [{ slug: "2gb", vcpu: 2, memoryMb: 2048 }],
		quotas: { default: { maxActiveSandboxes: 100, maxRamMb: 1_000_000 } },
		defaults: { defaultTemplate: templateSlug },
	});
}

export function testKeys(): KeyRing {
	return KeyRing.fromObject({
		current: 1,
		keys: { "1": randomBytes(32).toString("base64") },
	});
}

export interface TestLog {
	lines: string[];
	text(): string;
}

export function testLogger(level = "info"): {
	log: ReturnType<typeof createLogger>;
	captured: TestLog;
} {
	const lines: string[] = [];
	const sink = new Writable({
		write(chunk, _enc, cb) {
			lines.push(String(chunk));
			cb();
		},
	});
	return {
		log: createLogger({ level }, sink),
		captured: { lines, text: () => lines.join("") },
	};
}

/** startWorker options over fakes; fast pg-boss polling for tests. */
export function workerOptions(
	pool: pg.Pool,
	o: {
		infra: InfraRegistry;
		config: StaticConfigReader;
		keys: KeyRing;
	} & Partial<WorkerOptions>,
): WorkerOptions {
	const { log } = testLogger("warn");
	return {
		pool,
		agent: new FakeAgent(),
		gateway: new FakeGateway(),
		timing: TEST_TIMING,
		log,
		httpPort: null,
		pollingIntervalSeconds: 0.5,
		boss: { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1, ...o.boss },
		...o,
	};
}

/** Polls `cond` until it returns a value other than undefined/false. */
export async function until<T>(
	cond: () => Promise<T | undefined | false> | T | undefined | false,
	{ timeoutMs = 30_000, pollMs = 50, what = "condition" } = {},
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await cond();
		if (v !== undefined && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

export async function getText(
	url: string,
): Promise<{ status: number; body: string; type: string | null }> {
	const res = await fetch(url);
	return {
		status: res.status,
		body: await res.text(),
		type: res.headers.get("content-type"),
	};
}
