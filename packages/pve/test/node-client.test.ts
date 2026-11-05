import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import {
	NodeOpsError,
	parseKnownHosts,
	SshNodeOps,
} from "../src/node-client.ts";
import { sshKeyPair } from "./ssh-keys.ts";

const { Server } = ssh2;
const hostKeys = sshKeyPair();
const otherHostKeys = sshKeyPair();
const clientKeys = sshKeyPair();

function pubBlob(openssh: string): string {
	return openssh.split(" ")[1] ?? "";
}

let server: InstanceType<typeof Server> | undefined;
let clients: SshNodeOps[] = [];

/** Fake umiak-node behind an SSH server: echoes the op, fails op "boom". */
/**
 * Like OpenSSH, the server allows maxSessions sessions per connection and frees a session only a
 * moment after its channel closed (sshd collects dead channels in a later main loop pass).
 */
async function startServer(
	opts: {
		maxSessions?: number;
		freeDelayMs?: number;
		refuseFirst?: number;
	} = {},
): Promise<{
	port: number;
	requests: unknown[];
	refused: () => number;
	connections: () => number;
}> {
	const requests: unknown[] = [];
	let refused = 0;
	let connections = 0;
	let toRefuse = opts.refuseFirst ?? 0;
	server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
		let sessions = 0;
		client.on("error", () => {});
		client.on("authentication", (ctx) =>
			ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"]),
		);
		client.on("ready", () => {
			connections++;
		});
		client.on("session", (accept, reject) => {
			if (toRefuse > 0 || sessions >= (opts.maxSessions ?? 10)) {
				toRefuse = Math.max(0, toRefuse - 1);
				refused++;
				reject();
				return;
			}
			sessions++;
			accept().on("exec", (acceptExec) => {
				const stream = acceptExec();
				stream.on("close", () =>
					setTimeout(() => {
						sessions--;
					}, opts.freeDelayMs ?? 0),
				);
				let input = "";
				stream.on("data", (d: Buffer) => {
					input += d.toString();
				});
				stream.on("end", () => {
					const req = JSON.parse(input) as {
						op: string;
						args?: unknown;
						requestId: string;
					};
					requests.push(req);
					if (req.op === "hang") return;
					if (req.op === "boom") {
						stream.write(
							`${JSON.stringify({ ok: false, error: { code: "forbidden", message: "no" } })}\n`,
						);
						stream.exit(1);
					} else {
						stream.write(
							`${JSON.stringify({ ok: true, result: { op: req.op, args: req.args } })}\n`,
						);
						stream.exit(0);
					}
					stream.end();
				});
			});
		});
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	return {
		port: (server.address() as AddressInfo).port,
		requests,
		refused: () => refused,
		connections: () => connections,
	};
}

function client(port: number, knownHostKey = hostKeys.public): SshNodeOps {
	const c = new SshNodeOps({
		callTimeoutMs: 500,
		host: "127.0.0.1",
		port,
		privateKey: clientKeys.private,
		knownHosts: `[127.0.0.1]:${port} ssh-ed25519 ${pubBlob(knownHostKey)}\n`,
	});
	clients.push(c);
	return c;
}

afterEach(async () => {
	for (const c of clients) c.close();
	clients = [];
	const s = server;
	server = undefined;
	if (s) await new Promise((r) => s.close(r));
});

describe("parseKnownHosts", () => {
	it("returns the keys listed for the host only", () => {
		const text =
			"# comment\nother ssh-ed25519 AAAA\npve.x,10.0.0.1 ssh-ed25519 QUJD\npve.x ssh-rsa REVG\n";
		expect(parseKnownHosts(text, "pve.x").map((b) => b.toString())).toEqual([
			"ABC",
			"DEF",
		]);
		expect(parseKnownHosts(text, "nope")).toEqual([]);
	});
});

describe("parseKnownHosts host forms", () => {
	const key = Buffer.from("KEY").toString("base64");
	const hashed = (name: string) => {
		const salt = Buffer.from("0123456789abcdef0123");
		const h = createHmac("sha1", salt).update(name).digest();
		return `|1|${salt.toString("base64")}|${h.toString("base64")}`;
	};

	it("matches the Tailscale IP next to the name", () => {
		const text = `pve.ts.net,100.64.10.2 ssh-ed25519 ${key}\n`;
		expect(parseKnownHosts(text, "100.64.10.2")).toHaveLength(1);
		expect(parseKnownHosts(text, "pve.ts.net")).toHaveLength(1);
	});

	it("uses [host]:port for a non-standard port, like OpenSSH", () => {
		const text = `[10.0.0.1]:2222 ssh-ed25519 ${key}\n10.0.0.2 ssh-ed25519 ${key}\n`;
		expect(parseKnownHosts(text, "10.0.0.1", 2222)).toHaveLength(1);
		expect(parseKnownHosts(text, "10.0.0.1")).toHaveLength(0);
		expect(parseKnownHosts(text, "10.0.0.2", 2222)).toHaveLength(0);
		expect(
			parseKnownHosts(`[10.0.0.2]:22 ssh-ed25519 ${key}\n`, "10.0.0.2"),
		).toHaveLength(1);
	});

	it("matches hashed host names", () => {
		const text = `${hashed("100.64.10.2")} ssh-ed25519 ${key}\n`;
		expect(parseKnownHosts(text, "100.64.10.2")).toHaveLength(1);
		expect(parseKnownHosts(text, "100.64.10.3")).toHaveLength(0);
	});

	it("never pins a key that a @revoked line lists, for any host pattern", () => {
		const other = Buffer.from("OTHER").toString("base64");
		for (const revoked of ["pve", "*", "elsewhere"]) {
			const text = `pve ssh-ed25519 ${key}\npve ssh-ed25519 ${other}\n@revoked ${revoked} ssh-ed25519 ${key}\n`;
			expect(
				parseKnownHosts(text, "pve").map((b) => b.toString("base64")),
			).toEqual([other]);
		}
	});

	it("does not take @cert-authority keys as host keys", () => {
		const text = `@cert-authority pve ssh-ed25519 ${key}\n`;
		expect(parseKnownHosts(text, "pve")).toHaveLength(0);
	});
});

describe("SshNodeOps", () => {
	it("sends one JSON request per exec channel and returns the result", async () => {
		const { port, requests } = await startServer();
		const c = client(port);
		const results = await Promise.all([
			c.call("version"),
			c.call("lv.list", { tags: ["umiak"] }),
		]);
		expect(results).toEqual([
			{ op: "version", args: {} },
			{ op: "lv.list", args: { tags: ["umiak"] } },
		]);
		expect(requests).toHaveLength(2);
		expect((requests[0] as { requestId: string }).requestId).toMatch(
			/^[0-9a-f-]{36}$/,
		);
	});

	it("maps an error response to NodeOpsError with the code", async () => {
		const { port } = await startServer();
		const err = await client(port)
			.call("boom")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NodeOpsError);
		expect((err as NodeOpsError).code).toBe("forbidden");
	});

	it("refuses a host key that is not pinned", async () => {
		const { port } = await startServer();
		await expect(
			client(port, otherHostKeys.public).call("version"),
		).rejects.toThrow(/host key|verification/i);
	});
});

describe("SshNodeOps timeouts", () => {
	it("fails a call that gets no answer", async () => {
		const { port } = await startServer();
		await expect(client(port).call("hang")).rejects.toThrow(/timed out/);
	});
});

describe("SshNodeOps channel limits", () => {
	it("stays within MaxSessions under a burst of concurrent calls", async () => {
		const { port, requests } = await startServer({ freeDelayMs: 5 });
		const c = client(port);
		for (let round = 0; round < 5; round++) {
			const r = await Promise.allSettled(
				Array.from({ length: 32 }, () => c.call("version")),
			);
			expect(r.filter((x) => x.status === "rejected")).toEqual([]);
		}
		expect(requests).toHaveLength(160);
	});

	it("retries a refused channel open without sending the request twice", async () => {
		const { port, requests, refused } = await startServer({ refuseFirst: 2 });
		expect(await client(port).call("version")).toEqual({
			op: "version",
			args: {},
		});
		expect(refused()).toBe(2);
		expect(requests).toHaveLength(1);
	});
});

it("does not enable experimental delta sessions by default", async () => {
	const server = await startServer();
	const node = client(server.port);
	expect(node.deltaStreamEnabled).toBe(false);
	expect(node.portableFullStreamEnabled).toBe(false);
	await expect(node.openTransfer({})).rejects.toThrow(/disabled/);
	expect(server.requests).toHaveLength(0);
});
