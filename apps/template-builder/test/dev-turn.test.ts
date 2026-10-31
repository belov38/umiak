import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("dev TURN rollback removes only its rules and preserves concurrent changes", () => {
	const root = mkdtempSync(join(tmpdir(), "turn-firewall-"));
	try {
		const dir = join(root, "etc/pve/firewall");
		mkdirSync(dir, { recursive: true });
		const cluster =
			"[group sbx-egress]\nOUT ACCEPT -dest +sbx-gateway -p tcp -dport 443\nOUT DROP -dest +sbx-deny\n";
		writeFileSync(join(dir, "cluster.fw"), cluster);
		writeFileSync(join(dir, "590.fw"), "[RULES]\nIN ACCEPT -p tcp -dport 22\n");
		const run = (arg: string) =>
			spawnSync(
				"python3",
				[
					resolve(
						import.meta.dirname,
						"../../../infra/dev-cp/turn-firewall.py",
					),
					arg,
					root,
				],
				{ encoding: "utf8" },
			);
		expect(run("apply").status).toBe(0);
		expect(run("apply").status).toBe(0);
		const applied = readFileSync(join(dir, "cluster.fw"), "utf8");
		expect(applied.match(/s10-dev-turn/g)).toHaveLength(1);
		expect(applied).toContain(
			"OUT ACCEPT -dest +sbx-gateway -p udp -dport 3478 # s10-dev-turn",
		);
		writeFileSync(
			join(dir, "cluster.fw"),
			`${applied}# concurrent S9 change\n`,
		);
		expect(run("rollback").status).toBe(0);
		expect(readFileSync(join(dir, "cluster.fw"), "utf8")).toBe(
			`${cluster}# concurrent S9 change\n`,
		);
		expect(readFileSync(join(dir, "590.fw"), "utf8")).toBe(
			"[RULES]\nIN ACCEPT -p tcp -dport 22\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("TURN leaf issuance is idempotent and repairs a mismatched private key", () => {
	const root = mkdtempSync(join(tmpdir(), "turn-ca-"));
	try {
		const openssl = (...args: string[]) => {
			const result = spawnSync("openssl", args, { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
		};
		openssl(
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-keyout",
			join(root, "ca.key"),
			"-out",
			join(root, "ca.pem"),
			"-days",
			"90",
			"-subj",
			"/CN=Fixture CA",
		);
		const issue = () =>
			spawnSync(
				"bash",
				[resolve(import.meta.dirname, "../../../infra/dev-cp/turn-cert.sh")],
				{
					encoding: "utf8",
					env: {
						...process.env,
						SBX_DEVCP_CA_DIR: root,
						SBX_DEVCP_TURN_HOST: "turn.fixture.test",
					},
				},
			);
		expect(issue().status).toBe(0);
		const cert = readFileSync(join(root, "turn/tls.crt"));
		const decoded = spawnSync(
			"openssl",
			["x509", "-in", join(root, "turn/tls.crt"), "-text", "-noout"],
			{ encoding: "utf8" },
		);
		expect(decoded.stdout).toContain("ASN1 OID: prime256v1");
		expect(decoded.stdout).toContain("X509v3 Authority Key Identifier");
		expect(issue().status).toBe(0);
		expect(readFileSync(join(root, "turn/tls.crt"))).toEqual(cert);
		openssl(
			"genpkey",
			"-algorithm",
			"EC",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-out",
			join(root, "turn/tls.key"),
		);
		expect(issue().status).toBe(0);
		expect(readFileSync(join(root, "turn/tls.crt"))).not.toEqual(cert);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
