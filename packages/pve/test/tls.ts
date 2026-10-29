import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestPki {
	ca: string;
	key: string;
	cert: string;
}

/** Creates a throwaway CA and a server certificate for the given DNS name with the openssl CLI. */
export function makePki(dnsName: string): TestPki {
	const d = mkdtempSync(join(tmpdir(), "sbx-pki-"));
	const run = (...args: string[]) =>
		execFileSync("openssl", args, { cwd: d, stdio: "pipe" });
	run(
		"req",
		"-x509",
		"-sha256",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"1",
		"-subj",
		"/CN=test-ca",
	);
	run(
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"srv.key",
		"-out",
		"srv.csr",
		"-subj",
		`/CN=${dnsName}`,
	);
	writeFileSync(join(d, "ext.cnf"), `subjectAltName=DNS:${dnsName}\n`);
	run(
		"x509",
		"-req",
		"-sha256",
		"-in",
		"srv.csr",
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-CAcreateserial",
		"-out",
		"srv.pem",
		"-days",
		"1",
		"-extfile",
		"ext.cnf",
	);
	return {
		ca: readFileSync(join(d, "ca.pem"), "utf8"),
		key: readFileSync(join(d, "srv.key"), "utf8"),
		cert: readFileSync(join(d, "srv.pem"), "utf8"),
	};
}
