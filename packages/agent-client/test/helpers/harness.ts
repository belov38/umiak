// The Go tunnel harness (libs/tunnel/internal/cmd/tunnelharness): gateways
// with real internal listeners on 127.0.0.1, an in-memory tunnel network and
// agents serving the Process test double, controlled over HTTP.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FaultKind =
	| "cut"
	| "stall"
	| "drain"
	| "kill-gateway"
	| "restart-agent";

export const FAULT_KINDS: readonly FaultKind[] = [
	"cut",
	"stall",
	"drain",
	"kill-gateway",
	"restart-agent",
];

/** The JSON line the harness prints on stdout once it is ready. */
export interface HarnessInfo {
	machines: string[];
	gateways: { id: string; url: string }[];
	control: string;
}

/** What an injected fault touched (POST /fault 200). */
export interface FaultResult {
	kind: FaultKind;
	/** True when the fault hit links, a gateway or the agent. */
	applied: boolean;
	/** Machine links cut or stalled, or served by the drained or killed gateway. */
	links: number;
	gateway?: string;
	/** New agent instance id (restart-agent). */
	agent?: string;
}

export interface Harness extends HarnessInfo {
	/** File with the harness stderr (logs). */
	readonly logPath: string;
	/**
	 * Injects a fault. "busy" means the harness refused it (409): a fault of
	 * the same kind is still in progress, or the machine has no live link.
	 */
	fault(kind: FaultKind, machine: string): Promise<FaultResult | "busy">;
	/** How many times the double started the command's work (all machines). */
	starts(commandId: string): Promise<number>;
	/** How many Start/Run calls for the command reached an agent (retries included). */
	invocations(commandId: string): Promise<number>;
	/** How many SetLabel calls the double executed for the command. */
	labelCalls(commandId: string): Promise<number>;
	/** Closes stdin and waits for the exit; returns the exit code. */
	stop(): Promise<number | null>;
}

export interface HarnessOptions {
	/** Empty database; the harness applies the tunnel migrations. */
	databaseUrl: string;
	serviceToken: string;
	gateways?: number;
	agents?: number;
	/** How long to wait for the JSON line. Default 60 s. */
	readyTimeoutMs?: number;
}

let built: Promise<{ dir: string; bin: string }> | undefined;

/**
 * Builds the harness once per test run into a temporary directory.
 * SBX_E2E_RACE=1 builds it with the Go race detector.
 */
export function buildHarness(): Promise<{ dir: string; bin: string }> {
	built ??= (async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "sbx-tunnelharness-"));
		const bin = path.join(
			dir,
			process.platform === "win32" ? "tunnelharness.exe" : "tunnelharness",
		);
		const race = process.env.SBX_E2E_RACE === "1" ? ["-race"] : [];
		try {
			await run(
				"mise",
				[
					"exec",
					"--",
					"go",
					"build",
					...race,
					"-o",
					bin,
					"./internal/cmd/tunnelharness",
				],
				{ cwd: tunnelDir(), timeout: 5 * 60_000, maxBuffer: 16 << 20 },
			);
		} catch (err) {
			await rm(dir, { recursive: true, force: true });
			// The error message includes the command's stderr.
			throw new Error(`go build tunnelharness: ${String(err)}`);
		}
		return { dir, bin };
	})();
	return built;
}

/** Removes the build directory (binary and logs). */
export async function removeHarnessBuild(): Promise<void> {
	if (built === undefined) {
		return;
	}
	const b = built;
	built = undefined;
	const { dir } = await b.catch(() => ({ dir: "" }));
	if (dir !== "") {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Builds (once) and starts the harness, and waits for its JSON line. */
export async function startHarness(opts: HarnessOptions): Promise<Harness> {
	const { dir, bin } = await buildHarness();
	const logPath = path.join(
		dir,
		`harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
	);
	const log = createWriteStream(logPath);
	const child = spawn(
		bin,
		[
			"-db",
			opts.databaseUrl,
			"-token",
			opts.serviceToken,
			"-gateways",
			String(opts.gateways ?? 2),
			"-agents",
			String(opts.agents ?? 1),
		],
		{ cwd: tunnelDir(), stdio: ["pipe", "pipe", "pipe"] },
	);
	log.on("error", (err) => {
		console.error(`harness log ${logPath}: ${String(err)}`);
	});
	// pipe ends the log once stderr ends.
	child.stderr.pipe(log);
	const exited = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});
	// close comes after exit, once the child's stdio streams are closed.
	const closed = new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});

	let info: HarnessInfo;
	try {
		info = await readInfo(child, exited, opts.readyTimeoutMs ?? 60_000);
	} catch (err) {
		child.kill("SIGKILL");
		await closed;
		throw new Error(`${String(err)} (harness log: ${logPath})`);
	}

	let stopping: Promise<number | null> | undefined;
	const stop = () => {
		stopping ??= (async () => {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
			const hard = setTimeout(() => child.kill("SIGKILL"), 25_000);
			const code = await exited;
			clearTimeout(timer);
			clearTimeout(hard);
			await closed;
			await finished(log).catch(() => {});
			return code;
		})();
		return stopping;
	};

	return {
		...info,
		logPath,
		async fault(kind, machine) {
			const res = await fetch(`${info.control}/fault`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind, machine }),
			});
			const body = await res.text();
			if (res.status === 200) {
				return JSON.parse(body) as FaultResult;
			}
			if (res.status === 409) {
				return "busy";
			}
			throw new Error(`fault ${kind}: HTTP ${res.status}: ${body}`);
		},
		async starts(commandId) {
			return (await getJson(info.control, "starts", commandId)).starts ?? -1;
		},
		async invocations(commandId) {
			return (
				(await getJson(info.control, "invocations", commandId)).invocations ??
				-1
			);
		},
		async labelCalls(commandId) {
			return (await getJson(info.control, "labels", commandId)).calls ?? -1;
		},
		stop,
	};
}

async function getJson(
	control: string,
	what: string,
	commandId: string,
): Promise<{ starts?: number; invocations?: number; calls?: number }> {
	const res = await fetch(
		`${control}/${what}?command=${encodeURIComponent(commandId)}`,
	);
	if (res.status !== 200) {
		throw new Error(`GET /${what}: HTTP ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as {
		starts?: number;
		invocations?: number;
		calls?: number;
	};
}

function readInfo(
	child: ChildProcess,
	exited: Promise<number | null>,
	timeoutMs: number,
): Promise<HarnessInfo> {
	return new Promise((resolve, reject) => {
		if (child.stdout === null) {
			reject(new Error("harness stdout is not piped"));
			return;
		}
		const lines = createInterface({ input: child.stdout });
		const timer = setTimeout(() => {
			lines.close();
			reject(new Error(`harness not ready after ${timeoutMs} ms`));
		}, timeoutMs);
		lines.once("line", (line) => {
			clearTimeout(timer);
			lines.close();
			// Keep draining stdout: nothing more is expected, but a full pipe
			// would block the harness.
			child.stdout?.resume();
			try {
				resolve(JSON.parse(line) as HarnessInfo);
			} catch (err) {
				reject(new Error(`harness printed ${JSON.stringify(line)}: ${err}`));
			}
		});
		void exited.then((code) => {
			clearTimeout(timer);
			reject(new Error(`harness exited with code ${code} before it was ready`));
		});
	});
}

function tunnelDir(): string {
	let dir = import.meta.dirname;
	for (;;) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
			return path.join(dir, "libs", "tunnel");
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error("repo root (pnpm-workspace.yaml) not found");
		}
		dir = parent;
	}
}
