// A TLS front for the CLI's --cacert tests: a self-signed certificate for
// 127.0.0.1 (made by the system `openssl`) and an HTTPS reverse proxy that
// forwards by path prefix to plain HTTP servers in the test process.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsFront {
	/** https://127.0.0.1:<port> */
	url: string;
	/** Path of the PEM certificate (also the CA to trust). */
	caFile: string;
	/** Requests whose path starts with `prefix` go to `target` (http origin). */
	route(prefix: string, target: string): void;
	close(): Promise<void>;
}

export async function startTlsFront(): Promise<TlsFront> {
	const dir = mkdtempSync(join(tmpdir(), "sbx-tls-"));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=sbx test CA",
			"-addext",
			"subjectAltName=IP:127.0.0.1,DNS:localhost",
		],
		{ stdio: "ignore" },
	);
	const routes: { prefix: string; target: URL }[] = [];
	const server = createServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		(req, res) => {
			const r = routes.find((x) => (req.url ?? "").startsWith(x.prefix));
			if (r === undefined) {
				res.writeHead(502).end("no route");
				return;
			}
			const up = httpRequest(
				{
					host: r.target.hostname,
					port: r.target.port,
					method: req.method,
					path: req.url,
					headers: { ...req.headers, host: r.target.host },
				},
				(upRes) => {
					res.writeHead(upRes.statusCode ?? 502, upRes.headers);
					upRes.pipe(res);
				},
			);
			up.on("error", () => res.writeHead(502).end("upstream error"));
			req.pipe(up);
		},
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `https://127.0.0.1:${port}`,
		caFile: cert,
		route(prefix, target) {
			routes.push({ prefix, target: new URL(target) });
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					rmSync(dir, { recursive: true, force: true });
					resolve();
				});
			}),
	};
}
