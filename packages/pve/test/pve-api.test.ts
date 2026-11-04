import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isConnectionError,
	PveApi,
	PveApiError,
	PveTaskError,
	QgaTimeoutError,
} from "../src/pve-api.ts";
import { makePki } from "./tls.ts";

type Handler = (
	req: IncomingMessage,
	body: string,
	res: ServerResponse,
) => void;

const pvePki = makePki("pve");
const otherPki = makePki("other");
let server: Server | undefined;

async function serve(handler: Handler, pki = pvePki): Promise<string> {
	server = createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => handler(req, body, res));
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function api(url: string, ca = pvePki.ca) {
	return new PveApi({
		url,
		tokenId: "umiak@pve!dev",
		tokenSecret: "sec",
		ca,
		tlsName: "pve",
		retryDelayMs: 1,
	});
}

function json(
	res: ServerResponse,
	status: number,
	body: unknown,
	statusMessage?: string,
) {
	res.writeHead(status, statusMessage ?? "", {
		"content-type": "application/json",
	});
	res.end(JSON.stringify(body));
}

afterEach(async () => {
	const s = server;
	server = undefined;
	if (s) await new Promise((r) => s.close(r));
});

describe("PveApi", () => {
	it("sends the token header and a form body, and unwraps data", async () => {
		let seen: Record<string, string | undefined> = {};
		const url = await serve((req, body, res) => {
			seen = {
				auth: req.headers.authorization,
				body,
				path: req.url,
				type: req.headers["content-type"],
			};
			json(res, 200, { data: "UPID:x" });
		});
		const r = await api(url).post<string>("/nodes/pve/qemu", {
			vmid: 500,
			net0: "virtio=02:01:00:00:01:F4,bridge=umiak0",
			command: ["bash", "-c"],
		});
		expect(r).toBe("UPID:x");
		expect(seen.auth).toBe("PVEAPIToken=umiak@pve!dev=sec");
		expect(seen.path).toBe("/api2/json/nodes/pve/qemu");
		expect(seen.type).toBe("application/x-www-form-urlencoded");
		expect(seen.body).toBe(
			"vmid=500&net0=virtio%3D02%3A01%3A00%3A00%3A01%3AF4%2Cbridge%3Dumiak0&command=bash&command=-c",
		);
	});

	it("puts GET and DELETE params into the query string", async () => {
		const paths: string[] = [];
		const url = await serve((req, _b, res) => {
			paths.push(`${req.method} ${req.url}`);
			json(res, 200, { data: null });
		});
		await api(url).get("/cluster/resources", { type: "vm" });
		await api(url).delete("/nodes/pve/qemu/500", {
			purge: 1,
			"destroy-unreferenced-disks": 1,
		});
		expect(paths).toEqual([
			"GET /api2/json/cluster/resources?type=vm",
			"DELETE /api2/json/nodes/pve/qemu/500?purge=1&destroy-unreferenced-disks=1",
		]);
	});

	it("retries lock timeouts and counts the retries", async () => {
		let n = 0;
		const url = await serve((_req, _b, res) => {
			n++;
			if (n < 3)
				json(
					res,
					500,
					{ data: null },
					"can't lock file '/var/lock/qemu-server/lock-500.conf' - got timeout",
				);
			else json(res, 200, { data: 1 });
		});
		const a = api(url);
		expect(await a.put("/nodes/pve/qemu/500/config", { cores: 2 })).toBe(1);
		expect(n).toBe(3);
		expect(a.retryCount).toBe(2);
	});

	it("never retries a QGA timeout and reports it as QgaTimeoutError", async () => {
		const seen: string[] = [];
		const url = await serve((req, _b, res) => {
			seen.push(`${req.method} ${req.url?.split("?")[0]}`);
			const cmd = /agent\/([\w-]+)/.exec(req.url ?? "")?.[1];
			json(
				res,
				500,
				{ data: null },
				`VM 500 qga command 'guest-${cmd}' failed - got timeout`,
			);
		});
		const a = api(url);
		for (const [method, cmd] of [
			["GET", "exec-status"],
			["POST", "exec"],
			["POST", "fsfreeze-freeze"],
			["POST", "fsfreeze-thaw"],
		] as const) {
			const path = `/nodes/pve/qemu/500/agent/${cmd}`;
			const err = await a
				.request(method, path, method === "GET" ? { pid: 1 } : {})
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(QgaTimeoutError);
			expect(err).toBeInstanceOf(PveApiError);
			expect((err as QgaTimeoutError).command).toBe(`guest-${cmd}`);
		}
		expect(seen).toEqual([
			"GET /api2/json/nodes/pve/qemu/500/agent/exec-status",
			"POST /api2/json/nodes/pve/qemu/500/agent/exec",
			"POST /api2/json/nodes/pve/qemu/500/agent/fsfreeze-freeze",
			"POST /api2/json/nodes/pve/qemu/500/agent/fsfreeze-thaw",
		]);
		expect(a.retryCount).toBe(0);
	});

	it("does not repeat a guest agent GET after a connection error", async () => {
		let n = 0;
		const url = await serve((req, _b, res) => {
			n++;
			if (n === 1) req.socket.destroy();
			else json(res, 200, { data: { exited: 1 } });
		});
		await expect(
			api(url).get("/nodes/pve/qemu/500/agent/exec-status", { pid: 1 }),
		).rejects.toThrow();
		expect(n).toBe(1);
	});

	it("repeats a guest agent GET other than exec-status after a connection error, never a POST", async () => {
		const counts: Record<string, number> = {};
		const url = await serve((req, _b, res) => {
			const k = `${req.method} ${req.url?.split("?")[0]}`;
			counts[k] = (counts[k] ?? 0) + 1;
			if (counts[k] === 1) req.socket.destroy();
			else json(res, 200, { data: { result: [] } });
		});
		const a = api(url);
		expect(
			await a.get("/nodes/pve/qemu/500/agent/network-get-interfaces"),
		).toEqual({ result: [] });
		await expect(
			a.post("/nodes/pve/qemu/500/agent/exec", { command: "x" }),
		).rejects.toThrow(/socket hang up|ECONNRESET/);
		expect(counts).toEqual({
			"GET /api2/json/nodes/pve/qemu/500/agent/network-get-interfaces": 2,
			"POST /api2/json/nodes/pve/qemu/500/agent/exec": 1,
		});
		expect(a.retryCount).toBe(1);
	});

	it("isConnectionError: reset, hang up, timeouts and unreachable hosts, nothing else", () => {
		const withCode = (code: string, msg = code) =>
			Object.assign(new Error(msg), { code });
		for (const e of [
			withCode("ECONNRESET", "socket hang up"),
			withCode("ECONNRESET", "read ECONNRESET"),
			withCode("EPIPE"),
			withCode("ETIMEDOUT"),
			withCode("ECONNREFUSED"),
			withCode("EHOSTUNREACH"),
			withCode("ENETUNREACH"),
			withCode("EAI_AGAIN"),
			new Error("socket hang up"),
		])
			expect(isConnectionError(e), e.message).toBe(true);
		for (const e of [
			new Error("boom"),
			new PveApiError(500, "GET /x: socket hang up"),
			new PveApiError(503, "GET /x: service unavailable"),
			"socket hang up",
			null,
		])
			expect(isConnectionError(e), String(e)).toBe(false);
	});

	it("retries a lock timeout of a non-agent POST but not other timeouts", async () => {
		const counts: Record<string, number> = {};
		const url = await serve((req, _b, res) => {
			const p = req.url ?? "";
			counts[p] = (counts[p] ?? 0) + 1;
			if (p.endsWith("/status/start") && counts[p] === 1)
				json(
					res,
					500,
					{ data: null },
					"can't lock file '/var/lock/qemu-server/lock-500.conf' - got timeout",
				);
			else if (p.endsWith("/status/stop"))
				json(
					res,
					500,
					{ data: null },
					"VM 500 qmp command 'stop' failed - got timeout",
				);
			else json(res, 200, { data: "UPID:x" });
		});
		const a = api(url);
		expect(await a.post("/nodes/pve/qemu/500/status/start")).toBe("UPID:x");
		await expect(a.post("/nodes/pve/qemu/500/status/stop")).rejects.toThrow(
			/got timeout/,
		);
		expect(counts["/api2/json/nodes/pve/qemu/500/status/start"]).toBe(2);
		expect(counts["/api2/json/nodes/pve/qemu/500/status/stop"]).toBe(1);
	});

	it("throws PveApiError with the message and parameter errors", async () => {
		const url = await serve((_req, _b, res) =>
			json(res, 400, {
				data: null,
				message: "Parameter verification failed.",
				errors: { smbios1: "too long" },
			}),
		);
		const err = await api(url)
			.post("/nodes/pve/qemu", {})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PveApiError);
		expect((err as PveApiError).status).toBe(400);
		expect((err as PveApiError).errors).toEqual({ smbios1: "too long" });
		expect((err as PveApiError).message).toMatch(
			/Parameter verification failed/,
		);
	});

	it("verifies the certificate against the CA and the configured name", async () => {
		const url = await serve(
			(_req, _b, res) => json(res, 200, { data: 1 }),
			otherPki,
		);
		await expect(api(url, otherPki.ca).get("/version")).rejects.toThrow(
			/pve|altnames|hostname/i,
		);
	});

	it("parses responses with raw control characters inside strings", async () => {
		const url = await serve((_req, _b, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"data":{"out-data":"a\tb\u0001c\n"}}');
		});
		expect(await api(url).get("/x")).toEqual({ "out-data": "a\tb\u0001c\n" });
	});

	it("treats a task that ended with warnings as successful", async () => {
		const url = await serve((_req, _b, res) =>
			json(res, 200, {
				data: { status: "stopped", exitstatus: "WARNINGS: 1" },
			}),
		);
		await api(url).waitTask("pve", "UPID:w", { pollMs: 1 });
	});

	it("does not repeat a POST after a connection error, but repeats a GET", async () => {
		const counts: Record<string, number> = {};
		const url = await serve((req, _b, res) => {
			const m = req.method ?? "";
			counts[m] = (counts[m] ?? 0) + 1;
			if (counts[m] === 1) req.socket.destroy();
			else json(res, 200, { data: "ok" });
		});
		await expect(
			api(url).post("/nodes/pve/qemu", { vmid: 1 }),
		).rejects.toThrow();
		expect(counts.POST).toBe(1);
		expect(await api(url).get("/version")).toBe("ok");
		expect(counts.GET).toBe(2);
	});

	it("waitTask polls the UPID owner when an upload task runs on another cluster node", async () => {
		const upid =
			"UPID:pve:0007F31A:00CBC2F7:6AEAF945:imgcopy::umiak@pve!umiak:";
		const paths: string[] = [];
		const url = await serve((req, _body, res) => {
			paths.push(req.url ?? "");
			if (req.url?.startsWith("/api2/json/nodes/pve/tasks/"))
				json(res, 200, { data: { status: "stopped", exitstatus: "OK" } });
			else json(res, 404, { errors: { upid: "no such task" } });
		});
		await api(url).waitTask("pve2", upid, { pollMs: 1 });
		expect(paths).toEqual([
			`/api2/json/nodes/pve/tasks/${encodeURIComponent(upid)}/status`,
		]);
	});

	it("waitTask polls until stopped and reports failures", async () => {
		const states = [
			{ status: "running" },
			{ status: "stopped", exitstatus: "OK" },
		];
		const url = await serve((req, _b, res) => {
			if (req.url?.includes("UPID%3Aok"))
				json(res, 200, { data: states.shift() });
			else
				json(res, 200, {
					data: { status: "stopped", exitstatus: "unable to create VM 500" },
				});
		});
		await api(url).waitTask("pve", "UPID:ok", { pollMs: 1 });
		const err = await api(url)
			.waitTask("pve", "UPID:bad", { pollMs: 1 })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PveTaskError);
		expect((err as Error).message).toMatch(/unable to create VM 500/);
	});
});

describe("PveApi.upload", () => {
	async function serveRaw(
		handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
	): Promise<string> {
		server = createServer(
			{ key: pvePki.key, cert: pvePki.cert },
			(req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => handler(req, Buffer.concat(chunks), res));
			},
		);
		await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
		return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	function tmpFile(data: Buffer): string {
		const dir = mkdtempSync(join(tmpdir(), "umiak-upload-"));
		const p = join(dir, "file.bin");
		writeFileSync(p, data);
		return p;
	}

	it("streams multipart form data with the fields first and the file part last", async () => {
		// Larger than one read chunk, with bytes that are not valid UTF-8.
		const data = Buffer.alloc(300_000);
		for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
		const path = tmpFile(data);
		let seen: { req: IncomingMessage; body: Buffer; type: string } | undefined;
		const url = await serveRaw((req, body, res) => {
			seen = { req, body, type: String(req.headers["content-type"]) };
			json(res, 200, { data: "UPID:upload" });
		});
		const r = await api(url).upload(
			"/nodes/pve/storage/local/upload",
			{ content: "iso", checksum: "abc", "checksum-algorithm": "sha256" },
			{ name: "umiak-seed-1.iso", path, size: data.length },
		);
		expect(r).toBe("UPID:upload");
		if (!seen) throw new Error("no request");
		expect(seen.req.method).toBe("POST");
		expect(seen.req.url).toBe("/api2/json/nodes/pve/storage/local/upload");
		expect(seen.req.headers.authorization).toBe(
			"PVEAPIToken=umiak@pve!dev=sec",
		);
		expect(Number(seen.req.headers["content-length"])).toBe(seen.body.length);
		const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(
			seen.type,
		)?.[1];
		expect(boundary).toBeTruthy();
		const parts = splitMultipart(seen.body, String(boundary));
		// pveproxy rejects the body when checksum comes before checksum-algorithm.
		expect(parts.map((p) => p.headers)).toEqual([
			'Content-Disposition: form-data; name="content"',
			'Content-Disposition: form-data; name="checksum-algorithm"',
			'Content-Disposition: form-data; name="checksum"',
			'Content-Disposition: form-data; name="filename"; filename="umiak-seed-1.iso"\r\nContent-Type: application/octet-stream',
		]);
		expect(parts.slice(0, 3).map((p) => p.data.toString())).toEqual([
			"iso",
			"sha256",
			"abc",
		]);
		expect(parts[3]?.data.equals(data)).toBe(true);
	});

	it("reports an error answer as PveApiError and does not retry", async () => {
		let n = 0;
		const url = await serveRaw((_req, _body, res) => {
			n++;
			json(res, 503, { data: null }, "storage busy");
		});
		const path = tmpFile(Buffer.from("x"));
		const err = await api(url)
			.upload(
				"/nodes/pve/storage/local/upload",
				{ content: "iso" },
				{
					name: "a.iso",
					path,
					size: 1,
				},
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PveApiError);
		expect((err as PveApiError).status).toBe(503);
		expect(n).toBe(1);
	});

	it("fails when the file size differs from the declared size", async () => {
		const url = await serveRaw((_req, _body, res) =>
			json(res, 200, { data: "UPID:x" }),
		);
		const path = tmpFile(Buffer.from("12345"));
		await expect(
			api(url).upload(
				"/x/upload",
				{ content: "iso" },
				{
					name: "a.iso",
					path,
					size: 4,
				},
			),
		).rejects.toThrow(/size/);
	});

	it("rejects field and file names that would break the part headers", async () => {
		const path = tmpFile(Buffer.from("x"));
		await expect(
			api("https://127.0.0.1:1").upload(
				"/x",
				{ 'a"b': "v" },
				{
					name: "a.iso",
					path,
					size: 1,
				},
			),
		).rejects.toThrow(/name/);
		await expect(
			api("https://127.0.0.1:1").upload(
				"/x",
				{},
				{
					name: "a\r\n.iso",
					path,
					size: 1,
				},
			),
		).rejects.toThrow(/name/);
	});
});

/** Splits a multipart body into header blocks and data. */
function splitMultipart(
	body: Buffer,
	boundary: string,
): { headers: string; data: Buffer }[] {
	const delim = Buffer.from(`--${boundary}`);
	const parts: { headers: string; data: Buffer }[] = [];
	let pos = body.indexOf(delim);
	for (;;) {
		const start = pos + delim.length;
		if (body.subarray(start, start + 2).toString() === "--") break;
		const next = body.indexOf(delim, start);
		if (next < 0) throw new Error("unterminated multipart body");
		// Part = CRLF headers CRLF CRLF data CRLF
		const part = body.subarray(start + 2, next - 2);
		const sep = part.indexOf("\r\n\r\n");
		parts.push({
			headers: part.subarray(0, sep).toString(),
			data: part.subarray(sep + 4),
		});
		pos = next;
	}
	expect(body.subarray(pos).toString()).toBe(`--${boundary}--\r\n`);
	return parts;
}
