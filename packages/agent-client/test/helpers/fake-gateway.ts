// A fake gateway internal listener: h2c with the umiak.testing.v1.Process test
// service under /v1/machines/<id>/rpc (connect-node), HTTP/1.1 and h2c
// /v1/machines/<id>/files/* routes, and scripted 421/503 answers that match the
// Go gateway's wire format (Task 8 report) byte for byte where it matters.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import http2, {
	type Http2ServerRequest,
	type Http2ServerResponse,
} from "node:http2";
import net from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ErrorDetailSchema } from "@umiak/proto";
import {
	type AttachResponse,
	AttachResponseSchema,
	Process,
	Stream,
} from "../gen/umiak/testing/v1/process_pb.js";

type Req = IncomingMessage | Http2ServerRequest;
type NodeRes = ServerResponse | Http2ServerResponse;

/** The response methods used here, common to HTTP/1.1 and HTTP/2. */
interface Res {
	writeHead(status: number, headers?: Record<string, string>): unknown;
	write(chunk: Uint8Array, cb?: () => void): unknown;
	end(chunk?: string | Uint8Array): unknown;
}

export interface RecordedRequest {
	protocol: "h1" | "h2";
	method: string;
	/** Path with query, as received. */
	url: string;
	headers: Record<string, string | string[] | undefined>;
	/** Request body (files routes only). */
	body?: Buffer;
}

export type ScriptedAnswer =
	/**
	 * 421 with Umiak-Error-Code: machine_moved and Umiak-Instance-Url, and the
	 * URL in the body (ErrorDetail.instance_url or instanceUrl). headers:
	 * false leaves the Umiak-* headers out (the body alone carries the hint);
	 * code is the Connect code of the rpc body (default unavailable).
	 */
	| { kind: "moved"; instanceUrl: string; headers?: boolean; code?: string }
	/** 503 with Umiak-Error-Code: agent_unavailable and Retry-After: 1. */
	| { kind: "unavailable" }
	/** 200 Connect stream, half an envelope, then RST_STREAM INTERNAL_ERROR. */
	| { kind: "reset-mid-envelope" }
	/** A plain status without the gateway's Umiak-Error-Code (an agent answer). */
	| { kind: "plain"; status: number }
	/** A redirect (an agent answer passed through) to location. */
	| { kind: "redirect"; status: number; location: string }
	/** Exactly this status, headers and body: a compromised agent's answer. */
	| {
			kind: "raw";
			status: number;
			headers: Record<string, string>;
			body: Uint8Array;
	  };

export interface Scripted {
	answer: ScriptedAnswer;
	/** Only requests to this kind of route consume the entry (default: any). */
	route?: "rpc" | "files";
	/** Called right after the answer was written. */
	after?: () => void;
	/** How many requests get this answer (default 1; Infinity = until removed). */
	times?: number;
}

export interface FakeGateway {
	/** Base URL of the internal listener, e.g. http://127.0.0.1:1234. */
	url: string;
	/** Every request that passed authentication, in arrival order. */
	requests: RecordedRequest[];
	/** Scripted answers consumed by the next matching requests. */
	script: Scripted[];
	/** Files served by GET /files?path=. */
	files: Map<string, Uint8Array>;
	/** Bodies received by PUT /files/uploads/<id>, keyed by upload id. */
	uploads: Map<string, Buffer>;
	/** Output stdout of Attach/Run. */
	stdout: Uint8Array;
	/** SetLabel executions. */
	labelCalls: number;
	close(): Promise<void>;
}

export interface FakeGatewayOptions {
	token: string;
}

const rpcPrefix = /^\/v1\/machines\/([0-9a-f-]{36})\/(rpc|files)(\/.*)?$/;

/** Base64 (std, no padding) of a binary ErrorDetail, as connect-go writes it. */
function detailValue(code: string, instanceUrl?: string): string {
	const bin = toBinary(
		ErrorDetailSchema,
		create(ErrorDetailSchema, {
			code,
			retryable: true,
			instanceUrl: instanceUrl ?? "",
		}),
	);
	return Buffer.from(bin).toString("base64").replace(/=+$/, "");
}

function writeScripted(
	res: Res,
	route: "rpc" | "files",
	answer: ScriptedAnswer,
): void {
	if (answer.kind === "moved") {
		const body =
			route === "rpc"
				? JSON.stringify({
						code: answer.code ?? "unavailable",
						message: "machine_moved",
						details: [
							{
								type: "umiak.tunnel.v1.ErrorDetail",
								value: detailValue("machine_moved", answer.instanceUrl),
								debug: {
									code: "machine_moved",
									retryable: true,
									instanceUrl: answer.instanceUrl,
								},
							},
						],
					})
				: JSON.stringify({
						code: "machine_moved",
						instanceUrl: answer.instanceUrl,
					});
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (answer.headers !== false) {
			headers["umiak-error-code"] = "machine_moved";
			headers["umiak-instance-url"] = answer.instanceUrl;
		}
		if (route === "files") {
			headers["x-content-type-options"] = "nosniff";
		}
		res.writeHead(421, headers);
		res.end(body);
		return;
	}
	if (answer.kind === "unavailable") {
		const body =
			route === "rpc"
				? JSON.stringify({
						code: "unavailable",
						message: "agent_unavailable",
						details: [
							{
								type: "umiak.tunnel.v1.ErrorDetail",
								value: detailValue("agent_unavailable"),
								debug: { code: "agent_unavailable", retryable: true },
							},
						],
					})
				: JSON.stringify({ code: "agent_unavailable" });
		res.writeHead(503, {
			"content-type": "application/json",
			"retry-after": "1",
			"umiak-error-code": "agent_unavailable",
		});
		res.end(body);
		return;
	}
	if (answer.kind === "redirect") {
		res.writeHead(answer.status, {
			"content-type": "text/plain",
			location: answer.location,
		});
		res.end("moved elsewhere");
		return;
	}
	if (answer.kind === "raw") {
		res.writeHead(answer.status, answer.headers);
		res.end(answer.body);
		return;
	}
	if (answer.kind === "plain") {
		res.writeHead(answer.status, { "content-type": "text/plain" });
		res.end("agent says no");
		return;
	}
	// reset-mid-envelope: h2 only.
	const h2res = res as unknown as Http2ServerResponse;
	h2res.writeHead(200, { "content-type": "application/connect+proto" });
	const prefix = Buffer.from([0, 0, 0, 0, 100]);
	h2res.write(Buffer.concat([prefix, Buffer.alloc(10, 7)]), () => {
		setTimeout(
			() => h2res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR),
			20,
		);
	});
}

function processRoutes(gw: FakeGateway) {
	function* output(
		offset: bigint,
	): Generator<Omit<AttachResponse, "$typeName"> | AttachResponse> {
		const data = gw.stdout;
		for (let i = Number(offset); i < data.length; i += 4) {
			yield create(AttachResponseSchema, {
				event: {
					case: "data",
					value: {
						stream: Stream.STDOUT,
						offset: BigInt(i),
						data: data.subarray(i, Math.min(i + 4, data.length)),
					},
				},
			});
		}
		yield create(AttachResponseSchema, {
			event: {
				case: "exit",
				value: { code: 0, stdoutEnd: BigInt(data.length), stderrEnd: 0n },
			},
		});
	}
	return (router: ConnectRouter) =>
		router.service(Process, {
			setLabel(req) {
				if (req.label === "bad") {
					throw new ConnectError("bad label", Code.InvalidArgument);
				}
				gw.labelCalls++;
				return { calls: BigInt(gw.labelCalls) };
			},
			start(req) {
				return { commandId: req.commandId, created: true };
			},
			async *attach(req) {
				yield* output(req.stdoutOffset);
			},
			async *run(req) {
				yield create(AttachResponseSchema, {
					event: { case: "started", value: { commandId: req.commandId } },
				});
				yield* output(0n);
			},
			signal() {
				return {};
			},
		});
}

/** Starts a fake gateway on 127.0.0.1 with a random port. */
export async function startFakeGateway(
	opts: FakeGatewayOptions,
): Promise<FakeGateway> {
	const sockets = new Set<net.Socket>();
	const adapters = new Map<string, ReturnType<typeof connectNodeAdapter>>();
	const gw: FakeGateway = {
		url: "",
		requests: [],
		script: [],
		files: new Map(),
		uploads: new Map(),
		stdout: new TextEncoder().encode("0123456789abcdefghij"),
		labelCalls: 0,
		close: async () => {},
	};

	async function handle(
		protocol: "h1" | "h2",
		req: Req,
		nodeRes: NodeRes,
	): Promise<void> {
		const res = nodeRes as unknown as Res;
		const auth = req.headers.authorization;
		if (auth !== `Bearer ${opts.token}`) {
			req.resume();
			res.writeHead(401, {
				"content-type": "text/plain",
				"www-authenticate": "Bearer",
			});
			res.end("unauthenticated: missing or invalid service token");
			return;
		}
		const url = req.url ?? "/";
		const pathname = url.split("?")[0] ?? "/";
		const m = rpcPrefix.exec(pathname);
		const record: RecordedRequest = {
			protocol,
			method: req.method ?? "",
			url,
			headers: { ...req.headers },
		};
		gw.requests.push(record);
		if (m === null) {
			req.resume();
			res.writeHead(404);
			res.end();
			return;
		}
		const machineId = m[1] ?? "";
		const route = m[2] === "rpc" ? "rpc" : "files";
		const idx = gw.script.findIndex(
			(s) => s.route === undefined || s.route === route,
		);
		if (idx >= 0) {
			const s = gw.script[idx];
			if (s !== undefined) {
				s.times = (s.times ?? 1) - 1;
				if (s.times <= 0) {
					gw.script.splice(idx, 1);
				}
				if (route === "files") {
					record.body = await readBody(req);
				} else {
					req.resume();
				}
				writeScripted(res, route, s.answer);
				s.after?.();
				return;
			}
		}
		if (route === "rpc") {
			let adapter = adapters.get(machineId);
			if (adapter === undefined) {
				adapter = connectNodeAdapter({
					routes: processRoutes(gw),
					requestPathPrefix: `/v1/machines/${machineId}/rpc`,
				});
				adapters.set(machineId, adapter);
			}
			adapter(req, nodeRes);
			return;
		}
		record.body = await readBody(req);
		serveFiles(gw, m[3] ?? "", url, req, res, record.body);
	}

	const h1 = http.createServer((req, res) => {
		void handle("h1", req, res);
	});
	const h2 = http2.createServer((req, res) => {
		void handle("h2", req, res);
	});
	// One port for both protocols, like the Go internal listener: h2c prior
	// knowledge starts with the "PRI * HTTP/2.0" preface.
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.once("readable", () => {
			const chunk: Buffer | null = socket.read();
			if (chunk === null) {
				return;
			}
			socket.unshift(chunk);
			if (chunk.subarray(0, 4).toString() === "PRI ") {
				h2.emit("connection", socket);
			} else {
				h1.emit("connection", socket);
				socket.resume();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr === null || typeof addr === "string") {
		throw new Error("unexpected listen address");
	}
	gw.url = `http://127.0.0.1:${addr.port}`;
	gw.close = async () => {
		const closed = new Promise<void>((resolve) =>
			server.close(() => resolve()),
		);
		for (const s of sockets) {
			s.destroy();
		}
		await closed;
	};
	return gw;
}

async function readBody(req: Req): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const c of req) {
		chunks.push(c as Buffer);
	}
	return Buffer.concat(chunks);
}

function serveFiles(
	gw: FakeGateway,
	rest: string,
	url: string,
	req: Req,
	res: Res,
	body: Buffer,
): void {
	const query = new URL(url, "http://x").searchParams;
	if (req.method === "GET" && rest === "") {
		const data = gw.files.get(query.get("path") ?? "");
		if (data === undefined) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ code: "not_found" }));
			return;
		}
		let start = 0;
		let end = data.length - 1;
		let status = 200;
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
		if (range !== null) {
			start = Number(range[1]);
			if (range[2] !== undefined && range[2] !== "") {
				end = Math.min(end, Number(range[2]));
			}
			status = 206;
		}
		const headers: Record<string, string> = {
			"content-type": "application/octet-stream",
			"content-length": String(end - start + 1),
			etag: '"fake-etag"',
		};
		if (status === 206) {
			headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
		}
		res.writeHead(status, headers);
		// Write in small chunks so the client sees a streamed body.
		const slice = Buffer.from(data.subarray(start, end + 1));
		for (let i = 0; i < slice.length; i += 1024) {
			res.write(slice.subarray(i, i + 1024));
		}
		res.end();
		return;
	}
	const upload = /^\/uploads\/([A-Za-z0-9_-]+)$/.exec(rest);
	if (req.method === "PUT" && upload !== null) {
		const id = upload[1] ?? "";
		const offset = Number(query.get("offset") ?? "0");
		const prev = gw.uploads.get(id) ?? Buffer.alloc(0);
		const next = Buffer.concat([prev.subarray(0, offset), body]);
		gw.uploads.set(id, next);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ size: next.length }));
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ code: "not_found" }));
}

/**
 * A would-be token thief: an HTTP/1.1 and h2c listener that records every
 * request and then drops it. It counts HTTP requests, not TCP connections:
 * local tools probe new listening ports with plain connects.
 */
export interface Trap {
	url: string;
	/** HTTP requests received so far. */
	requests: RecordedRequest[];
	close(): Promise<void>;
}

export async function startTrap(): Promise<Trap> {
	const trap: Trap = { url: "", requests: [], close: async () => {} };
	const sockets = new Set<net.Socket>();
	const record = (protocol: "h1" | "h2", req: Req) => {
		trap.requests.push({
			protocol,
			method: req.method ?? "",
			url: req.url ?? "",
			headers: { ...req.headers },
		});
	};
	const h1 = http.createServer((req, res) => {
		record("h1", req);
		res.socket?.destroy();
	});
	h1.on("clientError", (_err, socket) => socket.destroy());
	const h2 = http2.createServer((req, res) => {
		record("h2", req);
		res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
	});
	h2.on("sessionError", () => {});
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.once("readable", () => {
			const chunk: Buffer | null = socket.read();
			if (chunk === null) {
				return;
			}
			socket.unshift(chunk);
			if (chunk.subarray(0, 4).toString() === "PRI ") {
				h2.emit("connection", socket);
			} else {
				h1.emit("connection", socket);
				socket.resume();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr === null || typeof addr === "string") {
		throw new Error("unexpected listen address");
	}
	trap.url = `http://127.0.0.1:${addr.port}`;
	trap.close = async () => {
		const closed = new Promise<void>((resolve) =>
			server.close(() => resolve()),
		);
		for (const s of sockets) {
			s.destroy();
		}
		await closed;
	};
	return trap;
}

/**
 * Asserts that no client request reached the trap: none with an
 * Authorization header, under /v1/ or naming the machine. Other requests
 * are local port probes (seen: a desktop app sending GET / without
 * credentials to every new localhost listener).
 */
export function expectNothingStolen(trap: Trap, machineId: string): void {
	const leaks = trap.requests.filter(
		(r) =>
			r.headers.authorization !== undefined ||
			r.url.startsWith("/v1/") ||
			r.url.includes(machineId),
	);
	if (leaks.length > 0) {
		throw new Error(
			`trap got a client request (service token, route or machine): ${JSON.stringify(leaks)}`,
		);
	}
}
