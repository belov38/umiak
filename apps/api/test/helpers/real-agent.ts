// The real guest agent for api tests: runs the umiak-agent-harness binary
// (built by agent-harness-global.ts) against the test database, for one
// machine, and a ConnectAgentApi over AgentClient + PgRegistry to it.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AgentClient, PgRegistry } from "@umiak/agent-client";
import type pg from "pg";
import { inject } from "vitest";
import { ConnectAgentApi } from "../../src/index.ts";
import "./agent-harness-provided.ts";

/** The JSON line of umiak-agent-harness. */
export interface HarnessInfo {
	internalUrl: string;
	serviceToken: string;
	machineId: string;
	capabilities: string[];
	/** Scratch directory; the home of the commands (cwd "" and HOME). */
	workDir: string;
	/** OS user the commands run as. */
	user: string;
	/** Port the fake procfs reports as listening. */
	listeningPort: number;
}

export interface RealAgent {
	info: HarnessInfo;
	agent: ConnectAgentApi;
	close(): Promise<void>;
}

/** Why the real-agent tests skip ("" when the harness was built). */
export function realAgentSkip(): string {
	return inject("umiakAgentHarness").skip;
}

/** How long the harness may take to serve its machine. */
const START_MS = 90_000;

/** Starts the harness for `machineId` against the test database. */
export async function startRealAgent(
	db: { url: string; pool: Pick<pg.Pool, "query"> },
	machineId: string,
): Promise<RealAgent> {
	const dbUrl = db.url;
	const { bin } = inject("umiakAgentHarness");
	const token = randomBytes(24).toString("base64url");
	const child = spawn(
		bin,
		["-database-url", dbUrl, "-service-token", token, "-machine-id", machineId],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (b: Buffer) => {
		stderr = (stderr + b.toString()).slice(-16_384);
		// UMIAK_HARNESS_LOG=1: the harness logs, shown as they come.
		if (process.env.UMIAK_HARNESS_LOG) process.stderr.write(b);
	});
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	let info: HarnessInfo;
	try {
		info = await firstLine(child, exited, () => stderr);
	} catch (e) {
		child.kill("SIGKILL");
		throw e;
	}
	const registry = await PgRegistry.connect({
		connectionString: dbUrl,
		maxConnections: 4,
	});
	const client = new AgentClient({
		registry,
		serviceToken: info.serviceToken,
		waitForAgentMs: 30_000,
	});
	return {
		info,
		agent: new ConnectAgentApi(client, db.pool),
		async close() {
			await client.close();
			await registry.close();
			// Closing stdin stops the harness; SIGKILL if it hangs.
			child.stdin?.end();
			const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
			await exited;
			clearTimeout(t);
		},
	};
}

/** Reads the harness's JSON line; rejects with its stderr if it exits first. */
function firstLine(
	child: ChildProcess,
	exited: Promise<void>,
	stderr: () => string,
): Promise<HarnessInfo> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(
			() =>
				reject(
					new Error(
						`the agent harness did not start in ${START_MS} ms:\n${stderr()}`,
					),
				),
			START_MS,
		);
		child.stdout?.on("data", (b: Buffer) => {
			buf += b.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			try {
				resolve(JSON.parse(buf.slice(0, nl)) as HarnessInfo);
			} catch (e) {
				reject(e);
			}
		});
		void exited.then(() => {
			clearTimeout(timer);
			reject(new Error(`the agent harness exited:\n${stderr()}`));
		});
	});
}
