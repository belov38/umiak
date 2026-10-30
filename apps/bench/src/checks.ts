import type { Qga } from "@sbx/pve";

export interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}

/** Runs fn and turns an exception into a failed check. */
export async function check(
	name: string,
	fn: () => Promise<boolean | string | { ok: boolean; detail?: string }>,
): Promise<Check> {
	try {
		const r = await fn();
		if (typeof r === "boolean") return { name, ok: r };
		if (typeof r === "string") return { name, ok: false, detail: r };
		return r.detail === undefined
			? { name, ok: r.ok }
			: { name, ok: r.ok, detail: r.detail };
	} catch (err) {
		return {
			name,
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * TCP probe inside the guest. Prints open, refused, timeout, unreach or error:<msg>. An error result
 * (for example a malformed address) fails the check instead of passing as "blocked".
 */
const TCP_PROBE = `
import errno, socket, sys
host, port = sys.argv[1], int(sys.argv[2])
try:
    fam, typ, proto, _, addr = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0]
    s = socket.socket(fam, typ, proto)
    s.settimeout(3)
    s.connect(addr)
    print("open")
except socket.timeout:
    print("timeout")
except ConnectionRefusedError:
    print("refused")
except OSError as e:
    print("unreach" if e.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH) else "error:" + str(e))
`;

export async function tcp(
	qga: Qga,
	vmid: number,
	host: string,
	port: number,
): Promise<string> {
	const r = await qga.exec(
		vmid,
		["python3", "-c", TCP_PROBE, host, String(port)],
		{ timeoutMs: 20_000 },
	);
	return r.stdout.trim() || `error:${r.stderr.trim()}`;
}

/** 0 = reply, 1 = no reply, 2 = error. */
export async function ping(
	qga: Qga,
	vmid: number,
	host: string,
	v6 = false,
): Promise<number> {
	const args = ["ping", ...(v6 ? ["-6"] : []), "-c1", "-W2", host];
	return (await qga.exec(vmid, args, { timeoutMs: 20_000 })).exitCode;
}

const blocked = (r: string) => r === "timeout" || r === "unreach";

export async function tcpBlocked(
	qga: Qga,
	vmid: number,
	host: string,
	port: number,
): Promise<{ ok: boolean; detail: string }> {
	const r = await tcp(qga, vmid, host, port);
	return { ok: blocked(r), detail: r };
}

export async function pingBlocked(
	qga: Qga,
	vmid: number,
	host: string,
	v6 = false,
): Promise<{ ok: boolean; detail: string }> {
	const code = await ping(qga, vmid, host, v6);
	return { ok: code === 1, detail: `ping exit ${code}` };
}

export interface NetTargets {
	lanGateway: string;
	hostLan: string;
	/** The operator's address of the host (SBX_NODE_SSH_HOST). */
	hostAddress: string;
	vnetGateway: string;
	hostLinkLocal: string;
	denyPublic: string[];
}

/** Network checks from inside a sandbox (spec §7.2 step 1.2). */
export async function networkChecks(
	qga: Qga,
	vmid: number,
	ifname: string,
	t: NetTargets,
): Promise<Check[]> {
	const c: Check[] = [];
	const p = `vm${vmid}`;
	c.push(
		await check(`${p} dns works`, async () => {
			const r = await qga.exec(vmid, ["getent", "hosts", "example.com"], {
				timeoutMs: 20_000,
			});
			return {
				ok: r.exitCode === 0,
				detail: r.stdout.trim().split("\n")[0] ?? "",
			};
		}),
	);
	c.push(
		await check(`${p} https works`, async () => {
			const r = await qga.exec(
				vmid,
				[
					"curl",
					"-fsS",
					"-o",
					"/dev/null",
					"-w",
					"%{http_code}",
					"--max-time",
					"10",
					"https://example.com",
				],
				{
					timeoutMs: 30_000,
				},
			);
			return { ok: r.exitCode === 0, detail: `${r.stdout} ${r.stderr}`.trim() };
		}),
	);
	c.push(
		await check(`${p} ping ${t.lanGateway} blocked`, () =>
			pingBlocked(qga, vmid, t.lanGateway),
		),
	);
	c.push(
		await check(`${p} tcp ${t.lanGateway}:80 blocked`, () =>
			tcpBlocked(qga, vmid, t.lanGateway, 80),
		),
	);
	for (const ip of t.denyPublic) {
		for (const port of [22, 80, 443])
			c.push(
				await check(`${p} tcp ${ip}:${port} blocked`, () =>
					tcpBlocked(qga, vmid, ip, port),
				),
			);
	}
	for (const [host, ports] of [
		[t.hostLan, [22, 8006]],
		[t.hostAddress, [22, 8006]],
		[t.vnetGateway, [22, 8006, 53]],
	] as const) {
		for (const port of ports)
			c.push(
				await check(`${p} tcp ${host}:${port} blocked`, () =>
					tcpBlocked(qga, vmid, host, port),
				),
			);
	}
	c.push(
		await check(`${p} no global IPv6 address or default route`, async () => {
			const r = await qga.bash(
				vmid,
				"ip -6 -o addr show scope global; ip -6 route show default",
			);
			return {
				ok: r.exitCode === 0 && r.stdout.trim() === "",
				detail: r.stdout.trim(),
			};
		}),
	);
	const ll = `${t.hostLinkLocal}%${ifname}`;
	c.push(
		await check(`${p} ping6 host link-local blocked`, () =>
			pingBlocked(qga, vmid, ll, true),
		),
	);
	c.push(
		await check(`${p} tcp [host link-local]:22 blocked`, () =>
			tcpBlocked(qga, vmid, ll, 22),
		),
	);
	c.push(
		await check(`${p} no tailscaled process and no tailscale0`, async () => {
			const r = await qga.bash(
				vmid,
				"command -v pgrep >/dev/null || echo no-pgrep; pgrep -a tailscaled; ip -o link show tailscale0 2>/dev/null; true",
			);
			return { ok: r.stdout.trim() === "", detail: r.stdout.trim() };
		}),
	);
	return c;
}

export function parseDmi(out: string): { serial: string; uuid: string } {
	const field = (k: string) =>
		out
			.split("\n")
			.find((l) => l.startsWith(`${k}=`))
			?.slice(k.length + 1)
			.trim() ?? "";
	return { serial: field("serial"), uuid: field("uuid").toLowerCase() };
}

export async function dmi(
	qga: Qga,
	vmid: number,
): Promise<{ serial: string; uuid: string }> {
	const r = await qga.bash(
		vmid,
		'echo "serial=$(cat /sys/class/dmi/id/product_serial)"; echo "uuid=$(cat /sys/class/dmi/id/product_uuid)"',
	);
	return parseDmi(r.stdout);
}
