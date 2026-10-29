import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import {
	NodeOpsError,
	parseKnownHosts,
	SshNodeOps,
} from "../src/node-client.ts";

const { Server, utils } = ssh2;
const hostKeys = utils.generateKeyPairSync("ed25519");
const otherHostKeys = utils.generateKeyPairSync("ed25519");
const clientKeys = utils.generateKeyPairSync("ed25519");

function pubBlob(openssh: string): string {
	return openssh.split(" ")[1] ?? "";
}

let server: InstanceType<typeof Server> | undefined;
let clients: SshNodeOps[] = [];

/** Fake sbx-node behind an SSH server: echoes the op, fails op "boom". */
async function startServer(): Promise<{ port: number; requests: unknown[] }> {
	const requests: unknown[] = [];
	server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) =>
			ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"]),
		);
		client.on("session", (accept) => {
			accept().on("exec", (acceptExec) => {
				const stream = acceptExec();
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
	return { port: (server.address() as AddressInfo).port, requests };
}

function client(port: number, knownHostKey = hostKeys.public): SshNodeOps {
	const c = new SshNodeOps({
		host: "127.0.0.1",
		port,
		privateKey: clientKeys.private,
		knownHosts: `127.0.0.1 ssh-ed25519 ${pubBlob(knownHostKey)}\n`,
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

describe("SshNodeOps", () => {
	it("sends one JSON request per exec channel and returns the result", async () => {
		const { port, requests } = await startServer();
		const c = client(port);
		const results = await Promise.all([
			c.call("version"),
			c.call("lv.list", { tags: ["sbx"] }),
		]);
		expect(results).toEqual([
			{ op: "version", args: {} },
			{ op: "lv.list", args: { tags: ["sbx"] } },
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
