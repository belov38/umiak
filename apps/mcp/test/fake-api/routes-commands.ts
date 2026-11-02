// Commands (S7 §9): start (sync, stream, detached), list, get, output by
// offsets, NDJSON stream, kill and signal.
import type { Context } from "hono";
import { FakeApiError, notFound, validation } from "./errors.ts";
import {
	claimIdempotency,
	iso,
	isoOrNull,
	limitOf,
	lookupSandbox,
	paginate,
	requireReady,
} from "./model.ts";
import {
	parseScenario,
	signalCommand,
	startRun,
	waitForCommand,
} from "./scenario.ts";
import {
	ByteLog,
	type CommandStatus,
	type Fake,
	type FakeApp,
	type FakeCommand,
	type FakeEnv,
	type FakeSandbox,
} from "./state.ts";
import { HOME } from "./vfs.ts";

type Json = Record<string, unknown>;
type Stream = "stdout" | "stderr";
type Frame = Record<string, unknown> & { type: string };

const STATUSES: CommandStatus[] = [
	"starting",
	"running",
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
];
/** Largest data frame (bytes of the stream). */
const FRAME_BYTES = 32 * 1024;
const SYNC_TAIL_BYTES = 4 * 1024 * 1024;

function streamInfo(cmd: FakeCommand, s: Stream) {
	const log: ByteLog = cmd[s];
	return {
		sizeBytes: log.size,
		availableFromBytes: cmd.availableFrom[s],
		endBytes: cmd.ended ? log.size : null,
	};
}

export function commandResource(cmd: FakeCommand, withStreams: boolean) {
	return {
		id: cmd.id,
		sandboxId: cmd.sandboxId,
		mode: cmd.mode,
		command: cmd.command,
		argv: cmd.argv,
		cwd: cmd.cwd,
		user: cmd.user,
		envKeys: Object.keys(cmd.env).sort(),
		tags: cmd.tags,
		timeoutSeconds: cmd.timeoutSeconds,
		status: cmd.status,
		exitCode: cmd.exitCode,
		signal: cmd.signal,
		reason: cmd.reason,
		pid: cmd.pid,
		outputTruncated: cmd.outputTruncated,
		streams: withStreams
			? { stdout: streamInfo(cmd, "stdout"), stderr: streamInfo(cmd, "stderr") }
			: null,
		createdBy: cmd.createdBy,
		createdByKey: cmd.createdByKey,
		createdAt: iso(cmd.createdAt),
		startedAt: isoOrNull(cmd.startedAt),
		endedAt: isoOrNull(cmd.endedAt),
	};
}

function findCommand(fake: Fake, sb: FakeSandbox, id: string): FakeCommand {
	const cmd = fake.state.commands.get(id);
	if (!cmd || cmd.sandboxId !== sb.id) throw notFound("command");
	return cmd;
}

/** Index of the first byte of an incomplete UTF-8 sequence at the end, else the length. */
function completeLength(buf: Uint8Array): number {
	for (let i = buf.length - 1; i >= Math.max(0, buf.length - 4); i--) {
		const b = buf[i] as number;
		if ((b & 0xc0) === 0x80) continue;
		const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
		return buf.length - i < need ? i : buf.length;
	}
	return buf.length;
}

/** The next data frame of a stream, or null when only an unfinished character is there. */
function nextDataFrame(
	cmd: FakeCommand,
	s: Stream,
	offset: number,
	encoding: "utf8" | "base64",
): Frame | null {
	const log = cmd[s];
	let chunk = log.slice(offset, offset + FRAME_BYTES);
	if (chunk.length === 0) return null;
	if (encoding === "base64") {
		return {
			type: s,
			offset,
			nextOffset: offset + chunk.length,
			data: chunk.toString("base64"),
		};
	}
	// utf8: the offsets stay on character boundaries until the stream ended.
	const last = cmd.ended && offset + chunk.length === log.size;
	if (!last) chunk = chunk.subarray(0, completeLength(chunk));
	if (chunk.length === 0) return null;
	return {
		type: s,
		offset,
		nextOffset: offset + chunk.length,
		data: new TextDecoder().decode(chunk),
	};
}

interface FrameOptions {
	offsets: Record<Stream, number>;
	follow: boolean;
	encoding: "utf8" | "base64";
	/** Frames before the data: `started` or `attached`. */
	head: Frame[];
}

/** The frames of S7 §9.5 for one stream request, until `exit` or the end of what exists. */
async function* commandFrames(
	fake: Fake,
	cmd: FakeCommand,
	o: FrameOptions,
	signal: AbortSignal,
): AsyncGenerator<Frame> {
	const offsets = { ...o.offsets };
	for (const f of o.head) yield f;
	for (const s of ["stdout", "stderr"] as const) {
		if (offsets[s] < cmd.availableFrom[s]) {
			offsets[s] = cmd.availableFrom[s];
			yield { type: "truncated", stream: s, availableFrom: offsets[s] };
		}
	}
	for (;;) {
		let progressed = false;
		for (const s of ["stdout", "stderr"] as const) {
			for (;;) {
				const f = nextDataFrame(cmd, s, offsets[s], o.encoding);
				if (f === null) break;
				offsets[s] = f.nextOffset as number;
				progressed = true;
				yield f;
			}
		}
		const drained =
			offsets.stdout >= cmd.stdout.size && offsets.stderr >= cmd.stderr.size;
		if (cmd.ended && drained) {
			yield {
				type: "exit",
				status: cmd.status,
				exitCode: cmd.exitCode,
				signal: cmd.signal,
				reason: cmd.reason,
				outputTruncated: cmd.outputTruncated,
				stdoutOffset: offsets.stdout,
				stderrOffset: offsets.stderr,
			};
			return;
		}
		if (!o.follow || signal.aborted) return;
		if (
			!progressed &&
			!(await waitForCommand(cmd, fake.opts.heartbeatMs, signal)) &&
			!signal.aborted
		) {
			yield { type: "heartbeat" };
		}
	}
}

/** An NDJSON response; frames are validated against CommandFrame as they go out. */
function ndjsonResponse(
	fake: Fake,
	c: Context<FakeEnv>,
	frames: (signal: AbortSignal) => AsyncGenerator<Frame>,
	headers: Record<string, string>,
): Response {
	const ac = new AbortController();
	const abort = () => ac.abort();
	c.req.raw.signal.addEventListener("abort", abort, { once: true });
	fake.closed.addEventListener("abort", abort, { once: true });
	const enc = new TextEncoder();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const frame of frames(ac.signal)) {
					fake.contractErrors.push(...fake.contract.validateFrame(frame));
					controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`));
					if (frame.type === "stdout" || frame.type === "stderr") {
						sent += (frame.nextOffset as number) - (frame.offset as number);
					}
					const cut = fake.script.breakStreamAfterBytes;
					if (cut !== undefined && sent >= cut) {
						delete fake.script.breakStreamAfterBytes;
						ac.abort();
						controller.error(new Error("fake api: stream cut"));
						return;
					}
				}
				controller.close();
			} catch (err) {
				try {
					controller.error(err);
				} catch {
					// already closed or cancelled
				}
			}
		},
		cancel() {
			ac.abort();
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "application/x-ndjson",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
			...headers,
		},
	});
}

function resolveCwd(cwd: unknown): string {
	if (typeof cwd !== "string" || cwd === "" || cwd === "~") return HOME;
	if (cwd.startsWith("/")) return cwd;
	return `${HOME}/${cwd.replace(/^~\//, "")}`;
}

export function registerCommandRoutes(app: FakeApp, fake: Fake): void {
	const { state } = fake;
	const base = "/v1/sandboxes/:sandbox/commands";

	app.get(base, (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const statuses = c.req
			.query("status")
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const bad = (statuses ?? []).filter(
			(s) => !STATUSES.includes(s as CommandStatus),
		);
		if (bad.length > 0) {
			throw validation([
				{
					path: "query.status",
					message: `unknown status ${bad.join(", ")}; one of ${STATUSES.join(", ")}`,
				},
			]);
		}
		const mode = c.req.query("mode");
		const items = [...state.commands.values()]
			.filter((cmd) => cmd.sandboxId === sb.id)
			.filter((cmd) => statuses === undefined || statuses.includes(cmd.status))
			.filter((cmd) => mode === undefined || cmd.mode === mode)
			.sort((a, b) => b.seq - a.seq);
		const page = paginate(items, {
			limit: limitOf(c, 50),
			cursor: c.req.query("cursor"),
			key: (cmd) => cmd.seq,
			dir: "desc",
		});
		return c.json({
			data: page.data.map((cmd) => commandResource(cmd, false)),
			nextCursor: page.nextCursor,
		});
	});

	app.post(base, async (c) => {
		const p = c.get("principal");
		const sb = lookupSandbox(fake, p, c.req.param("sandbox"));
		const b = c.get("json") as Json;
		const hasCommand = typeof b.command === "string";
		const hasArgv = Array.isArray(b.argv);
		if (hasCommand === hasArgv) {
			throw validation([
				{
					path: "command",
					message: "exactly one of command and argv is required",
				},
			]);
		}
		const mode =
			(b.mode as "sync" | "stream" | "detached" | undefined) ?? "sync";
		if (
			mode === "sync" &&
			typeof b.timeoutSeconds === "number" &&
			b.timeoutSeconds > 600
		) {
			throw validation([
				{ path: "timeoutSeconds", message: "at most 600 for sync" },
			]);
		}
		const encoding = (b.encoding as "utf8" | "base64" | undefined) ?? "utf8";
		await requireReady(fake, sb, c.req.raw.signal);
		const claim = claimIdempotency(fake, c, "commands.create", {
			sandbox: sb.id,
			body: b,
		});
		let cmd: FakeCommand | undefined;
		const replayed = claim?.replay != null;
		if (claim?.replay) {
			cmd = state.commands.get(claim.replay.commandId as string);
			if (!cmd)
				throw new FakeApiError(
					409,
					"idempotency_key_reused",
					"the command of this key is gone",
				);
		} else {
			const seq = state.commands.size + 1;
			const now = new Date();
			cmd = {
				id: fake.newId("cmd"),
				sandboxId: sb.id,
				mode,
				command: hasCommand ? (b.command as string) : null,
				argv: hasArgv ? (b.argv as string[]) : null,
				cwd: resolveCwd(b.cwd),
				user: (b.user as string | undefined) ?? "user",
				env: (b.env as Record<string, string> | undefined) ?? {},
				tags: (b.tags as Record<string, string> | undefined) ?? {},
				timeoutSeconds:
					(b.timeoutSeconds as number | null | undefined) ??
					(mode === "sync" ? 60 : null),
				status: "running",
				exitCode: null,
				signal: null,
				reason: null,
				pid: 1000 + seq,
				outputTruncated: null,
				createdBy: p.kind === "oidc" ? "usr_fake" : null,
				createdByKey: p.keyId ?? null,
				createdAt: now,
				startedAt: now,
				endedAt: null,
				stdout: new ByteLog(),
				stderr: new ByteLog(),
				availableFrom: { stdout: 0, stderr: 0 },
				ended: false,
				seq,
				timers: new Set(),
				waiters: new Set(),
			};
			state.commands.set(cmd.id, cmd);
			claim?.save({ commandId: cmd.id });
			const line = cmd.command ?? (cmd.argv ?? []).join(" ");
			startRun(fake, cmd, parseScenario(line));
			const hold = fake.script.holdCommandsPostMs;
			if (hold !== undefined) await fake.sleep(hold, c.req.raw.signal);
		}
		const live = cmd;
		const replayHeader: Record<string, string> = replayed
			? { "Idempotency-Replayed": "true" }
			: {};

		if (mode === "stream") {
			const head: Frame = {
				type: "started",
				commandId: live.id,
				pid: live.pid,
				encoding,
			};
			if (replayed) head.replayed = true;
			return ndjsonResponse(
				fake,
				c,
				(signal) =>
					commandFrames(
						fake,
						live,
						{
							offsets: { stdout: 0, stderr: 0 },
							follow: true,
							encoding,
							head: [head],
						},
						signal,
					),
				{ "Umiak-Command-Id": live.id, ...replayHeader },
			);
		}
		if (mode === "detached") {
			return c.json(commandResource(live, true), replayed ? 200 : 201, {
				"Umiak-Command-Id": live.id,
				...replayHeader,
			});
		}
		// sync: wait for the exit (the timeout of the process ends it)
		while (!live.ended && !c.req.raw.signal.aborted && !fake.closed.aborted) {
			await waitForCommand(live, 1000, c.req.raw.signal);
		}
		const tail = (s: Stream) => {
			const from = Math.max(
				live.availableFrom[s],
				live[s].size - SYNC_TAIL_BYTES,
			);
			return {
				from,
				text: live[s].slice(from, live[s].size).toString("utf8"),
				truncated: from > 0,
			};
		};
		const out = tail("stdout");
		const err = tail("stderr");
		return c.json(
			{
				command: commandResource(live, true),
				stdout: out.text,
				stderr: err.text,
				stdoutTruncated: out.truncated,
				stderrTruncated: err.truncated,
				stdoutFrom: out.from,
				stderrFrom: err.from,
			},
			200,
			{ "Umiak-Command-Id": live.id, ...replayHeader },
		);
	});

	app.get(`${base}/:command`, (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		return c.json(
			commandResource(findCommand(fake, sb, c.req.param("command")), true),
		);
	});

	app.get(`${base}/:command/output`, async (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const cmd = findCommand(fake, sb, c.req.param("command"));
		await requireReady(fake, sb, c.req.raw.signal);
		const stream = c.req.query("stream") ?? "stdout";
		if (stream !== "stdout" && stream !== "stderr") {
			throw validation([
				{ path: "query.stream", message: "the command has no pty stream" },
			]);
		}
		const log = cmd[stream];
		const offset = Number(c.req.query("offset") ?? 0);
		const limit = Number(c.req.query("limit") ?? 1024 * 1024);
		if (offset > log.size) {
			throw new FakeApiError(
				416,
				"range_not_satisfiable",
				`offset ${offset} is past the end of ${stream} (${log.size} bytes so far)`,
				{
					details: { stream, size: log.size },
				},
			);
		}
		const available = cmd.availableFrom[stream];
		const start = Math.max(offset, available);
		const bytes = log.slice(start, start + limit);
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Cache-Control": "no-store",
			"Umiak-Offset": String(start),
			"Umiak-Next-Offset": String(start + bytes.length),
			"Umiak-Available-From": String(available),
		};
		if (cmd.ended) headers["Umiak-Stream-End"] = String(log.size);
		if (offset < available) headers["Umiak-Truncated"] = "true";
		return new Response(new Uint8Array(bytes), { status: 200, headers });
	});

	app.get(`${base}/:command/stream`, async (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const cmd = findCommand(fake, sb, c.req.param("command"));
		await requireReady(fake, sb, c.req.raw.signal);
		if (Number(c.req.query("ptyOffset") ?? 0) > 0) {
			throw validation([
				{ path: "query.ptyOffset", message: "the command has no pty stream" },
			]);
		}
		const encoding =
			(c.req.query("encoding") as "utf8" | "base64" | undefined) ?? "utf8";
		const follow = c.req.query("follow") !== "false";
		const tail = c.req.query("tailBytes");
		const offsets = { stdout: 0, stderr: 0 };
		for (const s of ["stdout", "stderr"] as const) {
			const size = cmd[s].size;
			if (tail !== undefined) {
				offsets[s] = Math.max(cmd.availableFrom[s], size - Number(tail));
				continue;
			}
			const asked = Number(c.req.query(`${s}Offset`) ?? 0);
			if (asked > size) {
				throw new FakeApiError(
					416,
					"range_not_satisfiable",
					`${s}Offset ${asked} is past the end of ${s} (${size} bytes so far)`,
					{
						details: { stream: s, size },
					},
				);
			}
			offsets[s] = asked;
		}
		const head: Frame = {
			type: "attached",
			commandId: cmd.id,
			encoding,
			stdoutOffset: offsets.stdout,
			stderrOffset: offsets.stderr,
		};
		return ndjsonResponse(
			fake,
			c,
			(signal) =>
				commandFrames(
					fake,
					cmd,
					{ offsets, follow, encoding, head: [head] },
					signal,
				),
			{ "Umiak-Command-Id": cmd.id },
		);
	});

	app.post(`${base}/:command/kill`, async (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const cmd = findCommand(fake, sb, c.req.param("command"));
		await requireReady(fake, sb, c.req.raw.signal);
		signalCommand(fake, cmd, "SIGTERM");
		return c.json(commandResource(cmd, true));
	});

	app.post(`${base}/:command/signal`, async (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const cmd = findCommand(fake, sb, c.req.param("command"));
		await requireReady(fake, sb, c.req.raw.signal);
		signalCommand(fake, cmd, (c.get("json") as { signal: string }).signal);
		return c.json(commandResource(cmd, true));
	});
}
