import {
	createHash,
	createPrivateKey,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	familyForTunnelUrl,
	type Machines,
	type NodeOps,
	type ReadyInfo,
	type Smbios,
	type SnapshotRef,
	s2SerialPayload,
} from "@sbx/pve";
import type {
	BootTimes,
	CheckResult,
	Manifest,
	VerifyResult,
} from "./manifest.ts";
import type { GuestIo } from "./runner.ts";
import { verifyWindows } from "./windows/verify.ts";

// `sbx-tpl verify` (spec S5 section 10): a clone of the template, its hard restart, a fork with
// a new identity and a raw-disk scan for build secrets. The clones are removed at the end.

/** Tunnel URL of the test smbios family when no gateway is used: never resolves. */
export const TEST_TUNNEL_URL = "wss://tunnel.verify.invalid/v1/connect";
const SIZE = { cores: 2, memoryMb: 2048 };
const EXPECT_SUBNET = "10.88.0.0/24";
const MIN = 60_000;
const AGENT_ACTIVE_TIMEOUT_MS = MIN;
const TUNNEL_TIMEOUT_MS = MIN;
const VERIFY_SH_TIMEOUT_MS = 30 * MIN;
const DOCKER_TIMEOUT_MS = 5 * MIN;
/** Spec section 10 item 16: a hard restart may take at most this much longer than the first boot. */
export const HARD_RESTART_SLACK_MS = 3000;
/** Shorter key body lines (the tail of a PEM block) are too generic to scan for. */
const MIN_PATTERN_LENGTH = 20;
/** base64 of "openssh-key-v1": the first body line of every OpenSSH private key. */
const OPENSSH_HEADER = "b3BlbnNzaC1rZXktdjE";

/** Session registration of the dev gateway for the optional connect check. */
export interface TunnelRegistrar {
	register(machineId: string, bsHashHex: string): Promise<void>;
	/** State of the machine's tunnel session, null without one. */
	sessionState(machineId: string): Promise<string | null>;
	unregister(machineId: string): Promise<void>;
}

export interface VerifyConnect {
	url: string;
	registrar: TunnelRegistrar;
}

/** Local secret files whose contents must not be on the template disk. */
export interface SecretFiles {
	updateSigningKey: string;
	pveToken: string;
	nodeSshKey: string;
	devCaKey: string;
}

export function defaultSecretFiles(
	cfg: { tokenSecretFile: string; nodeSshKeyFile: string },
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): SecretFiles {
	return {
		updateSigningKey:
			env.SBX_UPDATE_SIGNING_KEY ??
			join(home, ".config/sbx/update-signing/ed25519.key"),
		pveToken: cfg.tokenSecretFile,
		nodeSshKey: cfg.nodeSshKeyFile,
		devCaKey: join(home, ".config/sbx/dev-ca/ca.key"),
	};
}

export interface VerifyDeps {
	/** S1 machines built with `templateVmid = manifest.pveVmid`. */
	machines: Pick<
		Machines,
		| "create"
		| "fork"
		| "start"
		| "stop"
		| "shutdown"
		| "delete"
		| "waitReady"
		| "snapshot"
		| "deleteSnapshot"
	>;
	io: (vmid: number) => GuestIo;
	/** sbx-node: lv.scan of the template and clone disks. */
	node: Pick<NodeOps, "call">;
	ramGuard: {
		reserve(vmid: number, memoryMb: number): Promise<void>;
		release(vmid: number): void;
	};
	/** infra/templates/<recipe.verify>/verify.sh (windows: verify.ps1) */
	verifyScript: string;
	/** Windows: QGA calls beyond exec (Qga of @sbx/pve). */
	windows?: WindowsGuestOps;
	secretFiles: SecretFiles;
	/** One message per call; secrets are already redacted. */
	log: (msg: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Poll interval of the agent and tunnel waits (default 2 s). */
	pollMs?: number;
	randomUUID?: () => string;
}

export interface WindowsGuestOps {
	fsfreezeFreeze(vmid: number): Promise<void>;
	/** autoThawed: the guest had already released the freeze (VSS hold timeout). */
	// biome-ignore lint/suspicious/noConfusingVoidType: fakes are `async () => {}`.
	fsfreezeThaw(vmid: number): Promise<void | { autoThawed?: boolean }>;
	fsfreezeStatus(vmid: number): Promise<"thawed" | "frozen">;
	/** Qga.fileWriteWindows: the path must not contain spaces or shell metacharacters. */
	writeFile(vmid: number, path: string, data: Buffer): Promise<void>;
}

export interface VerifyOptions {
	/** Leave the clones and the snapshot for inspection. */
	keep?: boolean;
	connect?: VerifyConnect;
	/** Checked between stages; the cleanup still runs. */
	signal?: AbortSignal;
}

const STATUSES = new Set(["PASS", "FAIL", "INFO"]);

/** `CHECK <id> <status> <evidence>` lines and the `TOOLS <json>` line of verify.sh. */
export function parseCheckLines(stdout: string): {
	checks: CheckResult[];
	tools: Record<string, { direct: string; login: string }>;
} {
	const checks: CheckResult[] = [];
	let tools: Record<string, { direct: string; login: string }> = {};
	for (const line of stdout.split("\n")) {
		const m = /^CHECK (\S+) (\S+) ?(.*)$/.exec(line);
		if (m) {
			const [, id = "", status = "", evidence = ""] = m;
			checks.push(
				STATUSES.has(status)
					? { id, status: status as CheckResult["status"], evidence }
					: { id, status: "FAIL", evidence: `status ${status}: ${evidence}` },
			);
		} else if (line.startsWith("TOOLS ")) {
			try {
				tools = JSON.parse(line.slice("TOOLS ".length));
			} catch (err) {
				checks.push({
					id: "verify_sh_tools",
					status: "FAIL",
					evidence: `TOOLS line is not JSON: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
	}
	return { checks, tools };
}

const pass = (id: string, ok: boolean, evidence: string): CheckResult => ({
	id,
	status: ok ? "PASS" : "FAIL",
	evidence,
});

/** Lower-case hex of a UUID without dashes. */
const uuidHex = (s: string) => s.replaceAll("-", "").toLowerCase();

/** `sbx-agent doctor --json` against the template and the test smbios (spec section 10 item 9). */
export function checkDoctor(
	doctorJson: unknown,
	expect: { agentVersion: string; machineId: string; tunnelUrl: string },
): CheckResult[] {
	const isReport = typeof doctorJson === "object" && doctorJson !== null;
	const d = (isReport ? doctorJson : {}) as {
		versions?: { current?: string };
		units?: Record<string, string>;
		identity?: { machine_id?: string } | null;
		identity_error?: string;
		tunnel_url?: { url?: string; source?: string };
		status?: { identity?: { state?: string; error?: string } } | null;
		test_aids?: string[];
	};
	const version = d.versions?.current;
	const units = d.units ?? {};
	const unitsOk =
		units["sbx-identity"] === "active" && units["sbx-agent"] === "active";
	const mid = d.identity?.machine_id;
	const idState = d.status?.identity?.state;
	const url = d.tunnel_url;
	const aids = d.test_aids;
	return [
		pass(
			"agent_version",
			version === expect.agentVersion,
			`current ${version ?? "none"}, manifest ${expect.agentVersion}`,
		),
		pass(
			"agent_units",
			unitsOk,
			`sbx-identity ${units["sbx-identity"] ?? "unknown"}, sbx-agent ${units["sbx-agent"] ?? "unknown"}`,
		),
		pass(
			"agent_identity",
			mid !== undefined &&
				uuidHex(mid) === uuidHex(expect.machineId) &&
				idState === "ready",
			`machine_id ${mid ?? `none (${d.identity_error ?? "no identity"})`}, state ${idState ?? "unknown"}${d.status?.identity?.error ? ` (${d.status.identity.error})` : ""}, want ${expect.machineId}`,
		),
		pass(
			"agent_tunnel_url",
			url?.url === expect.tunnelUrl && url?.source === "smbios",
			`${url?.url ?? "none"} (source ${url?.source ?? "none"}), want ${expect.tunnelUrl} from smbios`,
		),
		pass(
			"agent_test_aids",
			isReport &&
				(aids === undefined || (Array.isArray(aids) && aids.length === 0)),
			!isReport ? "no report" : aids?.length ? aids.join(", ") : "none",
		),
	];
}

/** Tools that may be absent from an image (no `--sbx-cli` at build). */
const OPTIONAL_TOOLS = new Set(["sbx"]);

/**
 * verify.sh TOOLS against the manifest (spec section 10 item 11): direct exec and login shell
 * agree and equal the build's value. A missing tool fails unless it is optional and was
 * missing at build as well.
 */
export function checkTools(
	tools: Record<string, { direct: string; login: string }>,
	manifestTools: Record<string, string | null>,
): CheckResult[] {
	const out: CheckResult[] = [];
	for (const [key, built] of Object.entries(manifestTools)) {
		const id = `tool_${key}`;
		const t = tools[key];
		if (!t) {
			out.push(pass(id, false, "not reported by verify.sh"));
			continue;
		}
		const want = built ?? "missing";
		if (t.direct !== t.login)
			out.push(pass(id, false, `direct "${t.direct}" != login "${t.login}"`));
		else if (t.direct !== want)
			out.push(pass(id, false, `"${t.direct}", manifest "${want}"`));
		else if (t.direct === "missing")
			out.push(
				pass(
					id,
					OPTIONAL_TOOLS.has(key),
					OPTIONAL_TOOLS.has(key) ? "missing (as built)" : "missing",
				),
			);
		else if (t.direct.startsWith("error:")) out.push(pass(id, false, t.direct));
		else out.push(pass(id, true, t.direct));
	}
	for (const key of Object.keys(tools))
		if (!(key in manifestTools))
			out.push(pass(`tool_${key}`, false, "not in the manifest"));
	return out;
}

/** Identity facts of a running clone. */
export interface Facts {
	/** smbios uuid the clone was created with. */
	uuid: string;
	/** /etc/machine-id */
	machineId: string;
	/** /sys/class/dmi/id/product_uuid */
	productUuid: string;
	hostname: string;
	/** SHA256 fingerprint of /etc/ssh/ssh_host_ed25519_key.pub */
	hostKey: string;
	/** DHCP IPv4 */
	ip: string;
	/** sha256 of /var/lib/systemd/random-seed, or "absent". */
	randomSeed: string;
	/** sha256 of /var/lib/systemd/credential.secret, or "absent". */
	credentialSecret: string;
	/** machineId in the agent's /var/lib/sbx-agent/identity.json. */
	agentMachineId: string;
	/** "1" when journalctl (this machine-id's journal) has the kernel's first line of this boot. */
	journalBoot: string;
}

/** A fork must not share its source's identity (spec section 2 anti-goals). */
export function checkForkIdentity(a: Facts, f: Facts): CheckResult[] {
	const own = (x: Facts) =>
		x.machineId !== "" &&
		x.machineId === uuidHex(x.uuid) &&
		uuidHex(x.productUuid) === uuidHex(x.uuid);
	const differ = (x: string, y: string) => x !== "" && y !== "" && x !== y;
	return [
		pass(
			"fork_machine_id",
			own(a) && own(f) && a.machineId !== f.machineId,
			`A ${a.machineId} (uuid ${a.productUuid}), F ${f.machineId} (uuid ${f.productUuid})`,
		),
		pass(
			"fork_hostname",
			differ(a.hostname, f.hostname),
			`A ${a.hostname}, F ${f.hostname}`,
		),
		pass(
			"fork_host_keys",
			differ(a.hostKey, f.hostKey),
			`A ${a.hostKey}, F ${f.hostKey}`,
		),
		pass("fork_ip", differ(a.ip, f.ip), `A ${a.ip}, F ${f.ip}`),
		pass(
			"fork_random_seed",
			differ(a.randomSeed, f.randomSeed) && a.randomSeed !== "absent",
			`A ${a.randomSeed.slice(0, 16)}, F ${f.randomSeed.slice(0, 16)}`,
		),
		pass(
			"fork_credential_secret",
			(a.credentialSecret === "absent" && f.credentialSecret === "absent") ||
				differ(a.credentialSecret, f.credentialSecret),
			`A ${a.credentialSecret.slice(0, 16)}, F ${f.credentialSecret.slice(0, 16)}`,
		),
		pass(
			"fork_agent_state",
			uuidHex(a.agentMachineId) === uuidHex(a.uuid) &&
				uuidHex(f.agentMachineId) === uuidHex(f.uuid),
			`A ${a.agentMachineId || "none"}, F ${f.agentMachineId || "none"}`,
		),
		// journald of a fork starts with the source's machine-id; the agent restarts it before the
		// flush, or F's journal lands in A's directory and `journalctl` in F finds none.
		pass(
			"fork_journal",
			a.journalBoot === "1" && f.journalBoot === "1",
			`whole boot in the own journal: A ${a.journalBoot || "?"}, F ${f.journalBoot || "?"}`,
		),
	];
}

/** Spec section 10 item 16. */
export function checkHardRestart(
	first: BootTimes,
	restart: BootTimes,
): CheckResult {
	const limit = first.startToQgaMs + HARD_RESTART_SLACK_MS;
	return pass(
		"hard_restart",
		restart.startToQgaMs <= limit,
		`start to QGA ${restart.startToQgaMs} ms after a hard stop, first boot ${first.startToQgaMs} ms, limit ${limit} ms`,
	);
}

/** Body lines of a PEM or OpenSSH private key block that identify this key. */
function keyBodyLines(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) =>
				l.length >= MIN_PATTERN_LENGTH &&
				!l.startsWith("-----") &&
				!l.includes(":") &&
				!l.startsWith(OPENSSH_HEADER),
		);
}

/**
 * Fixed strings the raw-disk scan looks for: the update signing key (PEM body, base64 and hex
 * of its seed), the PVE token secret, the sbx-node and dev CA key bodies, and the BS of the
 * verify clone. Missing files are skipped with a note.
 */
export function scanPatterns(
	files: SecretFiles,
	bs: Uint8Array,
): { patterns: string[]; notes: string[] } {
	const patterns: string[] = [];
	const notes: string[] = [];
	const read = (path: string): string | undefined => {
		if (!existsSync(path)) {
			notes.push(`${path}: missing, skipped`);
			return undefined;
		}
		return readFileSync(path, "utf8");
	};

	const signing = read(files.updateSigningKey);
	if (signing !== undefined) {
		patterns.push(...keyBodyLines(signing));
		try {
			const jwk = createPrivateKey(signing).export({ format: "jwk" });
			if (jwk.crv !== "Ed25519" || typeof jwk.d !== "string")
				throw new Error("not ed25519");
			const seed = Buffer.from(jwk.d, "base64url");
			patterns.push(
				seed.toString("base64").replace(/=+$/, ""),
				jwk.d,
				seed.toString("hex"),
			);
		} catch {
			notes.push(
				`${files.updateSigningKey}: not an ed25519 key, seed forms skipped`,
			);
		}
	}
	const token = read(files.pveToken)?.trim();
	if (token) patterns.push(token);
	for (const f of [files.nodeSshKey, files.devCaKey]) {
		const text = read(f);
		if (text !== undefined) patterns.push(...keyBodyLines(text));
	}
	const b = Buffer.from(bs);
	patterns.push(b.toString("base64url"), b.toString("hex"));
	return { patterns: [...new Set(patterns)], notes };
}

/** Replaces every pattern in `text`. */
function redactor(patterns: string[]): (text: string) => string {
	const sorted = [...patterns].sort((x, y) => y.length - x.length);
	return (text) => {
		let out = text;
		for (const p of sorted) out = out.replaceAll(p, "[redacted]");
		return out;
	};
}

/** Result of `sbx-node lv.scan`: the patterns stay on the host (never sent to a guest). */
export interface ScanResult {
	matches: number;
	scannedBytes: number;
}

/** One `raw_disk_secrets` check from the host-side scans of the template and the clone. */
export function scanCheck(
	results: { disk: string; r?: ScanResult; error?: string }[],
): CheckResult {
	const failed = results.filter(
		(x) => x.error !== undefined || (x.r?.matches ?? 1) > 0,
	);
	const text = results
		.map((x) =>
			x.error !== undefined
				? `${x.disk}: scan failed: ${x.error}`
				: `${x.disk}: ${x.r?.matches} matches in ${Math.round((x.r?.scannedBytes ?? 0) / 2 ** 30)} GiB`,
		)
		.join("; ");
	return pass("raw_disk_secrets", failed.length === 0, text);
}

/**
 * Spec section 10 item 16: the menu timeout grub.cfg uses after a failed boot (recordfail) is 0,
 * whatever grubenv holds now (Ubuntu clears recordfail once a boot succeeds).
 */
const GRUB_SCRIPT = [
	"env=$(grub-editenv /boot/grub/grubenv list 2>&1 | tr '\\n' ' ')",
	'  t=$(awk \'/\\$\\{recordfail\\}" = 1/ { f = 1; next } f && /set timeout=/ { sub(/.*set timeout=/, ""); print; exit }\' /boot/grub/grub.cfg)',
	'if [ "$t" = 0 ]; then echo "CHECK grub_recordfail PASS recordfail timeout $t in grub.cfg; grubenv: $env"',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: bash
	'else echo "CHECK grub_recordfail FAIL recordfail timeout ${t:-not found} in grub.cfg; grubenv: $env"; fi',
].join("\n");

const FACTS_SCRIPT = [
	'echo "machine_id=$(cat /etc/machine-id)"',
	'echo "product_uuid=$(cat /sys/class/dmi/id/product_uuid)"',
	'echo "hostname=$(hostname)"',
	"echo \"host_key=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{ print $2 }')\"",
	"for f in random-seed credential.secret; do",
	'  if [ -e "/var/lib/systemd/$f" ]; then echo "$f=$(sha256sum "/var/lib/systemd/$f" | cut -d" " -f1)"; else echo "$f=absent"; fi',
	"done",
	'echo "agent_machine_id=$(grep -o \'"machineId": *"[^"]*"\' /var/lib/sbx-agent/identity.json | cut -d\'"\' -f4)"',
	"echo \"journal_boot=$(journalctl -b -q --no-pager -o cat -t kernel 2>/dev/null | head -1 | grep -c '^Linux version')\"",
].join("\n");

const DOCKER_SCRIPT = "docker info >/dev/null && docker run --rm hello-world";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Clone {
	vmid: number;
	uuid: string;
	bs: Buffer;
	smbios: Smbios;
	reserved: boolean;
	ready?: ReadyInfo;
}

export async function verifyTemplate(
	deps: VerifyDeps,
	manifest: Manifest,
	o: VerifyOptions = {},
): Promise<VerifyResult> {
	if (manifest.os === "windows") return verifyWindows(deps, manifest, o);
	const tplVmid = manifest.pveVmid;
	const size =
		manifest.templateSlug === "linux-desktop"
			? { cores: 4, memoryMb: 4096 }
			: SIZE;
	if (tplVmid === null) throw new Error("the build has no template VMID");
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? 2000;
	const uuid = deps.randomUUID ?? randomUUID;
	const { machines } = deps;
	const { signal } = o;
	const tunnelUrl = o.connect?.url ?? TEST_TUNNEL_URL;
	const family = familyForTunnelUrl(tunnelUrl);
	const identity = () => {
		const id = uuid();
		const bs = randomBytes(32);
		return {
			uuid: id,
			bs,
			smbios: { uuid: id, serial: s2SerialPayload(id, bs), family },
		};
	};

	const a = identity();
	const scan = scanPatterns(deps.secretFiles, a.bs);
	const redact = redactor(scan.patterns);
	const log = (msg: string) => deps.log(redact(msg));
	const checks: CheckResult[] = [];
	const add = (...cs: CheckResult[]) => {
		for (const c of cs) {
			const r = { ...c, evidence: redact(c.evidence) };
			checks.push(r);
			log(`${r.status.padEnd(4)}  ${r.id}  ${r.evidence}`);
		}
	};
	const step = (what: string) => {
		signal?.throwIfAborted();
		log(`verify: ${what}`);
	};

	let cloneA: Clone | undefined;
	let cloneF: Clone | undefined;
	let snap: SnapshotRef | undefined;
	let registered = false;
	const boot: VerifyResult["boot"] = {
		first: { startToQgaMs: 0, startToIpMs: 0 },
		hardRestart: { startToQgaMs: 0, startToIpMs: 0 },
	};
	let kvm: VerifyResult["kvm"] = { available: false, reason: "not reported" };

	const reserve = async (c: Clone) => {
		await deps.ramGuard.reserve(c.vmid, size.memoryMb);
		c.reserved = true;
	};

	/** Starts a clone and waits for QGA, the IPv4 and an active sbx-agent. */
	const startClone = async (c: Clone, label: string): Promise<BootTimes> => {
		const startedAt = now();
		await machines.start(c.vmid);
		const ready = await machines.waitReady(c.vmid, {
			startedAt,
			timeoutMs: manifest.bootTimeoutS * 1000,
		});
		c.ready = ready;
		const times: BootTimes = {
			startToQgaMs: ready.pingAt - startedAt,
			startToIpMs: ready.ipAt - startedAt,
		};
		const active = await waitAgentActive(deps.io(c.vmid));
		if (active.at !== undefined)
			times.startToAgentActiveMs = active.at - startedAt;
		add(
			pass(
				`${label}agent_active`,
				active.at !== undefined,
				`sbx-agent ${active.state}${active.at !== undefined ? ` ${active.at - startedAt} ms after start` : ` after ${AGENT_ACTIVE_TIMEOUT_MS} ms`}`,
			),
		);
		log(
			`VM ${c.vmid}: QGA ${times.startToQgaMs} ms, IPv4 ${ready.ip} ${times.startToIpMs} ms after start`,
		);
		return times;
	};

	const waitAgentActive = async (
		io: GuestIo,
	): Promise<{ state: string; at?: number }> => {
		const deadline = now() + AGENT_ACTIVE_TIMEOUT_MS;
		let state = "unknown";
		for (;;) {
			signal?.throwIfAborted();
			try {
				const r = await io.exec(["systemctl", "is-active", "sbx-agent"]);
				state = r.stdout.trim() || `exit ${r.exitCode}`;
			} catch (err) {
				state = `unknown: ${errorText(err)}`;
			}
			if (state === "active") return { state, at: now() };
			if (now() >= deadline) return { state };
			await sleep(pollMs);
		}
	};

	const facts = async (c: Clone): Promise<Facts> => {
		const r = await deps.io(c.vmid).exec(["bash", "-c", FACTS_SCRIPT]);
		const kv: Record<string, string> = {};
		for (const line of r.stdout.split("\n")) {
			const i = line.indexOf("=");
			if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
		}
		return {
			uuid: c.uuid,
			machineId: kv.machine_id ?? "",
			productUuid: kv.product_uuid ?? "",
			hostname: kv.hostname ?? "",
			hostKey: kv.host_key ?? "",
			ip: c.ready?.ip ?? "",
			randomSeed: kv["random-seed"] ?? "",
			credentialSecret: kv["credential.secret"] ?? "",
			agentMachineId: kv.agent_machine_id ?? "",
			journalBoot: kv.journal_boot ?? "",
		};
	};

	let failure: unknown;
	try {
		if (o.connect) {
			step(`registering machine ${a.uuid} with the tunnel gateway`);
			registered = true;
			await o.connect.registrar.register(
				a.uuid,
				createHash("sha256").update(a.bs).digest("hex"),
			);
		}

		step(`cloning template ${tplVmid}`);
		const A: Clone = {
			...a,
			vmid: (await machines.create({ size, smbios: a.smbios })).vmid,
			reserved: false,
		};
		cloneA = A;
		await reserve(A);
		const io = deps.io(A.vmid);
		step(`booting VM ${A.vmid}`);
		boot.first = await startClone(A, "");

		step("guest checks (verify.sh)");
		const vs = await io.exec(["bash", "-s"], {
			input: `export MACHINE_ID=${A.uuid}\nexport EXPECT_SUBNET=${EXPECT_SUBNET}\n${deps.verifyScript}`,
			timeoutMs: VERIFY_SH_TIMEOUT_MS,
		});
		const parsed = parseCheckLines(vs.stdout);
		if (vs.exitCode !== 0 || !/^TOOLS /m.test(vs.stdout))
			add(
				pass(
					"verify_sh",
					false,
					`exit ${vs.exitCode}: ${vs.stderr.trim().split("\n").slice(-5).join(" | ")}`,
				),
			);
		add(...parsed.checks);
		const k = parsed.checks.find((c) => c.id === "kvm")?.evidence;
		if (k === "available") kvm = { available: true };
		else if (k?.startsWith("unavailable: "))
			kvm = { available: false, reason: k.slice("unavailable: ".length) };
		add(...checkTools(parsed.tools, manifest.tools));

		step("agent (sbx-agent doctor)");
		const dr = await io.exec(["sbx-agent", "doctor", "--json"]);
		let doc: unknown = null;
		try {
			doc = JSON.parse(dr.stdout);
		} catch {
			log(`sbx-agent doctor: exit ${dr.exitCode}: ${dr.stderr.trim()}`);
		}
		add(
			...checkDoctor(doc, {
				agentVersion: manifest.agentVersion,
				machineId: A.uuid,
				tunnelUrl,
			}),
		);

		if (o.connect) {
			step("tunnel session");
			add(await waitTunnel(o.connect.registrar, A.uuid));
		} else
			add({
				id: "tunnel_connected",
				status: "INFO",
				evidence: "skipped: no --connect-url",
			});

		step("docker hello-world");
		const dk = await io.exec(["bash", "-c", DOCKER_SCRIPT], {
			timeoutMs: DOCKER_TIMEOUT_MS,
		});
		add(
			pass(
				"docker",
				dk.exitCode === 0 && dk.stdout.includes("Hello from Docker!"),
				dk.exitCode === 0
					? (dk.stdout.split("\n").find((l) => l.trim() !== "") ?? "")
					: `exit ${dk.exitCode}: ${dk.stderr.trim()}`,
			),
		);

		step("raw-disk secret scan");
		add({
			id: "raw_disk_patterns",
			status: "INFO",
			evidence: [`${scan.patterns.length} patterns`, ...scan.notes].join("; "),
		});
		// On the host through sbx-node: the template disk (build secrets) and A's disk after a boot
		// (the BS must not reach it). The guest never sees the patterns.
		const scans: { disk: string; r?: ScanResult; error?: string }[] = [];
		for (const disk of [`base-${tplVmid}-disk-0`, `vm-${A.vmid}-disk-0`]) {
			try {
				scans.push({
					disk,
					r: await deps.node.call<ScanResult>("lv.scan", {
						name: disk,
						patterns: scan.patterns,
					}),
				});
			} catch (err) {
				scans.push({ disk, error: errorText(err) });
			}
		}
		add(scanCheck(scans));

		step(`hard stop and restart of VM ${A.vmid}`);
		await machines.stop(A.vmid);
		boot.hardRestart = await startClone(A, "restart_");
		add(checkHardRestart(boot.first, boot.hardRestart));
		add(
			...parseCheckLines((await io.exec(["bash", "-c", GRUB_SCRIPT])).stdout)
				.checks,
		);
		if (!checks.some((c) => c.id === "grub_recordfail"))
			add(pass("grub_recordfail", false, "grubenv check printed nothing"));

		step(`snapshot of VM ${A.vmid} and fork`);
		snap = await machines.snapshot(A.vmid);
		const f = identity();
		const F: Clone = {
			...f,
			vmid: (await machines.fork(snap, { size, smbios: f.smbios })).vmid,
			reserved: false,
		};
		cloneF = F;
		// Desktop verification shares the host with other build tracks. Preserve
		// source evidence before stopping it; the fork never needs both guests live.
		const sourceFacts = await facts(A);
		if (manifest.templateSlug === "linux-desktop") {
			await machines.stop(A.vmid);
			deps.ramGuard.release(A.vmid);
			A.reserved = false;
		}
		await reserve(F);
		step(`booting fork VM ${F.vmid}`);
		await startClone(F, "fork_");
		add(...checkForkIdentity(sourceFacts, await facts(F)));
	} catch (err) {
		failure = err;
	}

	// Cleanup: fork, snapshot, clone, registration. Every part is attempted.
	const problems: string[] = [];
	const attempt = async (what: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			problems.push(`${what}: ${errorText(err)}`);
		}
	};
	if (o.keep) {
		log(
			`--keep: leaving ${[cloneA, cloneF]
				.filter((c) => c !== undefined)
				.map((c) => `VM ${c.vmid}`)
				.join(", ")}${snap ? `, snapshot ${snap.id}` : ""}`,
		);
	} else {
		for (const c of [cloneF, cloneA]) {
			if (c === undefined) continue;
			if (c === cloneA && snap !== undefined) {
				const s = snap;
				await attempt(`snapshot ${s.id}`, () => machines.deleteSnapshot(s));
			}
			await attempt(`VM ${c.vmid}`, () => machines.delete(c.vmid));
		}
		if (cloneA === undefined && snap !== undefined) {
			const s = snap;
			await attempt(`snapshot ${s.id}`, () => machines.deleteSnapshot(s));
		}
	}
	for (const c of [cloneF, cloneA])
		if (c?.reserved) deps.ramGuard.release(c.vmid);
	if (registered && o.connect) {
		const reg = o.connect.registrar;
		await attempt("tunnel registration", () => reg.unregister(a.uuid));
	}

	if (failure !== undefined) {
		for (const p of problems) log(`cleanup: ${p}`);
		throw failure;
	}
	if (problems.length > 0) add(pass("cleanup", false, problems.join("; ")));
	else if (!o.keep) log("cleanup: clones, snapshot and registration removed");

	const forkChecks = checks.filter((c) => c.id.startsWith("fork_"));
	return {
		ok: !checks.some((c) => c.status === "FAIL"),
		checks,
		boot,
		kvm,
		fork: {
			ok: forkChecks.length > 0 && forkChecks.every((c) => c.status !== "FAIL"),
		},
		at: new Date(now()).toISOString(),
	};

	function waitTunnel(
		reg: TunnelRegistrar,
		machineId: string,
	): Promise<CheckResult> {
		return waitTunnelSession(reg, machineId, {
			now,
			sleep,
			pollMs,
			...(signal !== undefined ? { signal } : {}),
		});
	}
}

/** Polls the dev gateway until the machine's tunnel session is connected (at most 60 s). */
export async function waitTunnelSession(
	reg: TunnelRegistrar,
	machineId: string,
	o: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		pollMs: number;
		signal?: AbortSignal;
	},
): Promise<CheckResult> {
	const deadline = o.now() + TUNNEL_TIMEOUT_MS;
	let last = "no session";
	for (;;) {
		o.signal?.throwIfAborted();
		try {
			const st = await reg.sessionState(machineId);
			if (st?.startsWith("connected"))
				return pass("tunnel_connected", true, `session ${st}`);
			last = st === null ? "no session" : `session ${st}`;
		} catch (err) {
			last = `error: ${errorText(err)}`;
		}
		if (o.now() >= deadline)
			return pass(
				"tunnel_connected",
				false,
				`${last} after ${TUNNEL_TIMEOUT_MS} ms`,
			);
		await o.sleep(o.pollMs);
	}
}
