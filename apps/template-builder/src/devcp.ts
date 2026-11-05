import { spawn } from "node:child_process";
import type { TunnelRegistrar } from "./verify.ts";

// Optional manual verification against an installer-managed control-plane CT.
// Executes psql in the private Compose project over SSH, with SQL on stdin.

const PSQL =
	"cd /opt/umiak && docker compose exec -T postgres psql -U umiak -d umiak -v ON_ERROR_STOP=1 -Atq";
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Runs `ssh <args>` with `input` on stdin and returns stdout. */
export type SshExec = (args: string[], input: string) => Promise<string>;

const sshExec: SshExec = (args, input) =>
	new Promise((resolve, reject) => {
		const p = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d: Buffer) => {
			out += d.toString("utf8");
		});
		p.stderr.on("data", (d: Buffer) => {
			err += d.toString("utf8");
		});
		p.on("error", reject);
		p.on("close", (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(`ssh ${args[2]}: exit ${code}: ${err.trim()}`));
		});
		p.stdin.end(input);
	});

function machineId(id: string): string {
	if (!UUID_RE.test(id)) throw new Error(`not a machine id: ${id}`);
	return id;
}

export function devCpRegistrar(o: {
	ctSsh: string;
	exec?: SshExec;
}): TunnelRegistrar {
	if (!/^[A-Za-z0-9._@-]+$/.test(o.ctSsh) || o.ctSsh.startsWith("-"))
		throw new Error(`--dev-cp-ssh must be [user@]host: ${o.ctSsh}`);
	const exec = o.exec ?? sshExec;
	const sql = (text: string) =>
		exec(["-o", "BatchMode=yes", o.ctSsh, PSQL], `${text}\n`);
	return {
		async register(id, bsHashHex) {
			const mid = machineId(id);
			if (!SHA256_RE.test(bsHashHex))
				throw new Error("BS hash must be 64 lower-case hex digits");
			await sql(
				`INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash) VALUES ('${mid}', '\\x${bsHashHex}');`,
			);
		},
		async sessionState(id) {
			const out = await sql(
				`SELECT state FROM tunnel.tunnel_sessions WHERE machine_id = '${machineId(id)}';`,
			);
			return out.trim() || null;
		},
		async unregister(id) {
			const mid = machineId(id);
			await sql(
				`DELETE FROM tunnel.tunnel_sessions WHERE machine_id = '${mid}';\nDELETE FROM tunnel.tunnel_credentials WHERE machine_id = '${mid}';`,
			);
		},
	};
}
