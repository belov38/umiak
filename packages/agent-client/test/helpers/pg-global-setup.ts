// Vitest global setup: provides an admin Postgres DSN to the test workers.
// SBX_TEST_DATABASE_URL is used as is; otherwise a postgres:18.6-alpine
// container is started once through the docker CLI and removed in teardown.
// SBX_TEST_SKIP_PG=1 without a URL makes database tests skip instead of fail.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

const image = "postgres:18.6-alpine";

let containerId: string | undefined;

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
		await run("docker", ["rm", "-f", containerId]).catch(() => {});
		containerId = undefined;
	}
}

async function startContainer(): Promise<string> {
	const { stdout } = await run(
		"docker",
		[
			"run",
			"-d",
			"--rm",
			"--label",
			"sbx-test=agent-client",
			"-e",
			"POSTGRES_PASSWORD=sbx",
			"-p",
			"127.0.0.1::5432",
			image,
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

declare module "vitest" {
	export interface ProvidedContext {
		sbxPgAdminDsn: string;
		sbxPgError: string;
	}
}
