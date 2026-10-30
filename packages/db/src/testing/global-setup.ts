// Vitest global setup: provides an admin Postgres DSN to the test workers.
// SBX_TEST_DATABASE_URL is used as is; otherwise a postgres:18.6-alpine
// container is started once through the docker CLI and removed in teardown.
// A run killed before its teardown does not leave it behind: a watchdog
// removes it when this process is gone, and the next setup removes
// containers of dead owners (container-guard.ts).
// SBX_TEST_SKIP_PG=1 without a URL makes database tests skip; a missing Docker
// without that flag makes every createTestDatabase() call fail.
//
// Other packages reference it from vitest.config.ts:
//   globalSetup: ["@sbx/db/testing/global-setup"]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";
import {
	containerName,
	currentOwner,
	ownerLabels,
	removeOrphans,
	startWatchdog,
	type Watchdog,
} from "./container-guard.ts";
import "./provided.ts";

const run = promisify(execFile);

export const TEST_PG_IMAGE = "postgres:18.6-alpine";

let containerId: string | undefined;
let watchdog: Watchdog | undefined;

export async function setup(project: TestProject): Promise<void> {
	const url = process.env.SBX_TEST_DATABASE_URL;
	if (url) {
		project.provide("sbxPgAdminDsn", url);
		project.provide("sbxPgError", "");
		return;
	}
	if (process.env.SBX_TEST_SKIP_PG === "1") {
		project.provide("sbxPgAdminDsn", "");
		project.provide("sbxPgError", "");
		return;
	}
	try {
		project.provide("sbxPgAdminDsn", await startContainer());
		project.provide("sbxPgError", "");
	} catch (err) {
		project.provide("sbxPgAdminDsn", "");
		project.provide(
			"sbxPgError",
			`postgres unavailable: ${String(err)} (set SBX_TEST_DATABASE_URL, or SBX_TEST_SKIP_PG=1 to skip database tests)`,
		);
	}
}

export async function teardown(): Promise<void> {
	if (containerId !== undefined) {
		// -v: the image declares a data volume; without it every run leaves an
		// anonymous volume behind.
		await run("docker", ["rm", "-f", "-v", containerId]).catch(() => {});
		containerId = undefined;
	}
	watchdog?.stop();
	watchdog = undefined;
}

async function startContainer(): Promise<string> {
	await removeOrphans();
	const owner = await currentOwner();
	// The watchdog is up before the container exists (see container-guard.ts).
	const name = containerName();
	watchdog = await startWatchdog(name);
	const { stdout } = await run(
		"docker",
		[
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			...ownerLabels(owner),
			"-e",
			"POSTGRES_PASSWORD=sbx",
			"-p",
			"127.0.0.1::5432",
			TEST_PG_IMAGE,
			// Throwaway data: trade durability for speed; room for parallel workers.
			"-c",
			"fsync=off",
			"-c",
			"synchronous_commit=off",
			"-c",
			"full_page_writes=off",
			"-c",
			"max_connections=500",
		],
		{ timeout: 5 * 60_000 }, // the image may need a pull
	);
	containerId = stdout.trim();
	const port = await run("docker", ["port", containerId, "5432/tcp"]);
	// Output looks like "127.0.0.1:49153" and may list an IPv6 line too.
	const line = port.stdout.trim().split("\n")[0] ?? "";
	const hostPort = line.slice(line.lastIndexOf(":") + 1);
	const dsn = `postgres://postgres:sbx@127.0.0.1:${hostPort}/postgres?sslmode=disable`;
	await waitReady(dsn, 60_000);
	return dsn;
}

async function waitReady(dsn: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		const client = new pg.Client({
			connectionString: dsn,
			connectionTimeoutMillis: 2000,
		});
		client.on("error", () => {});
		try {
			await client.connect();
			await client.query("SELECT 1");
			await client.end();
			return;
		} catch (err) {
			last = err;
			await client.end().catch(() => {});
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`postgres not ready after ${timeoutMs} ms: ${String(last)}`);
}
