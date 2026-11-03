import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Test-only CA and localhost certificate for externally managed HTTPS proxies. */
export async function testTls(dir) {
	await mkdir(dir, { recursive: true });
	const path = (name) => join(dir, name);
	const openssl = (...args) =>
		execFileSync("openssl", args, { stdio: "ignore" });
	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		path("ca-key.pem"),
		"-out",
		path("ca.pem"),
		"-days",
		"1",
		"-subj",
		"/CN=Umiak proxy test CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign",
	);
	openssl(
		"req",
		"-new",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		path("key.pem"),
		"-out",
		path("server.csr"),
		"-subj",
		"/CN=localhost",
	);
	await writeFile(
		path("server.ext"),
		"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
	);
	openssl(
		"x509",
		"-req",
		"-in",
		path("server.csr"),
		"-CA",
		path("ca.pem"),
		"-CAkey",
		path("ca-key.pem"),
		"-CAcreateserial",
		"-out",
		path("cert.pem"),
		"-days",
		"1",
		"-extfile",
		path("server.ext"),
	);
	return {
		key: await readFile(path("key.pem")),
		cert: await readFile(path("cert.pem")),
		caFile: path("ca.pem"),
	};
}
