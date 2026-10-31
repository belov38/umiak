import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type ExecResult,
	FreezeBudgetExceededError,
	familyForTunnelUrl,
	type Smbios,
	type SnapshotRef,
	s2SerialPayload,
} from "@sbx/pve";
import type {
	BootTimes,
	CheckResult,
	LicenseInfo,
	Manifest,
	VerifyBoot,
	VerifyResult,
} from "../manifest.ts";
import {
	checkTools,
	parseCheckLines,
	TEST_TUNNEL_URL,
	type VerifyDeps,
	type VerifyOptions,
	waitTunnelSession,
} from "../verify.ts";

// `sbx-tpl verify` of a Windows template (spec S9 section 15): clone A from the template boots
// through specialize, OOBE and the agent's rename reboot (R16); guest checks (verify.ps1 over QGA), agent checks through the sbx-agent CLI,
// secrets, VSS; then an S1 snapshot of A, A shut down, fork B with a new identity (one rename
// reboot, data and password kept), a normal and a hard restart of B. Everything is removed at the
// end. At most one Windows VM runs at a time (4 GB each, Decision 9).

export const PWSH_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
/** Written with Qga.fileWriteWindows, whose paths allow no spaces. */
export const GUEST_SCRIPT = "C:\\Windows\\Temp\\sbx-verify.ps1";
const SIZE = { cores: 2, memoryMb: 4096 };
const EXPECT_SUBNET = "10.88.0.0/24";
const USER = "user";
const SECRET_NAME = "sbx-verify";
const SECRET_PATH = `C:\\ProgramData\\sbx\\secrets\\files\\${SECRET_NAME}`;
const MARKER_PATH = "C:\\Users\\user\\sbx-verify-marker.txt";
const DPAPI_PATH = "C:\\Users\\user\\sbx-verify-dpapi.txt";
const FILES_DIR = "C:\\Users\\user\\sbx-verify-files";
const MIN = 60_000;
const SHUTDOWN_TIMEOUT_S = 120;
const VERIFY_PS1_TIMEOUT_MS = 30 * MIN;
const CHECK_TIMEOUT_MS = 5 * MIN;
const AGENT_TIMEOUT_MS = 2 * MIN;
const LICENSE_WAIT_MS = 10 * MIN;
const LICENSE_POLL_MS = 30_000;
const LOG_LINES = 2000;
const CLEANUP_TRIES = 3;
const CLEANUP_RETRY_MS = 10_000;
/** qmeventd's cleanup of the previous QEMU holds the VM lock for up to 30 s after a restart. */
const LOCK_TRIES = 5;
const LOCK_RETRY_MS = 10_000;
const LOCK_TIMEOUT_RE = /can't lock file .* got timeout/;
/** Spec 15.1 p.12: freeze to thaw. */
const FREEZE_LIMIT_MS = 10_000;
/** Spec 15.1 p.14: a hard restart may take at most this much longer than a normal boot. */
export const HARD_STOP_SLACK_MS = 10_000;
/** Boots of a fork: the first applies the new identity and reboots for the rename (spec 11.2 p.8). */
const FORK_BOOTS = 2;
const DAY_MS = 86_400_000;

// --- Agent CLI contract (spec S9 12.14, plan Task 17), assumed here; Task 26 adjusts it. ---
// verify.ps1 builds the same `exec` argv itself (marker "agent CLI contract" in that file).
// sbx-agent.exe runs as SYSTEM through QGA exec and talks to the agent over the admin socket:
//   exec [--user <u>] [--shell <script>] -- <argv...>   exit code = the command's; 125 = agent or
//                                                        CLI error, 127 = the command did not start
//   call <package.Service/Method> -                      Connect JSON request on stdin, response on stdout
//   doctor --json | logs -n <N> | selftest --pty
// `call ... -` (request from stdin) is required: secret values must not reach a guest command
// line, which qemu-ga logs. The admin socket skips WaitSecrets (a command as user does not wait
// for UpdateSecrets), but the boot gate (a failed boot step) still refuses commands of non-SYSTEM
// users.

export const AGENT_EXE = "C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe";
const INFO = "sbx.agent.v1.System/Info";
const CLAIM = "sbx.agent.v1.System/Claim";
const UPDATE_SECRETS = "sbx.agent.v1.System/UpdateSecrets";
const PREPARE_STOP = "sbx.agent.v1.System/PrepareStop";
const FS = (method: string) => `sbx.agent.v1.Filesystem/${method}`;

export function agentExecCmd(o: {
	user?: string;
	shell?: string;
	argv?: string[];
}): string[] {
	const cmd = [AGENT_EXE, "exec"];
	if (o.user !== undefined) cmd.push("--user", o.user);
	if (o.shell !== undefined) cmd.push("--shell", o.shell);
	else cmd.push("--", ...(o.argv ?? []));
	return cmd;
}

export const agentCallCmd = (method: string): string[] => [
	AGENT_EXE,
	"call",
	method,
	"-",
];

export const agentDoctorCmd = (): string[] => [AGENT_EXE, "doctor", "--json"];

export const agentLogsCmd = (lines: number): string[] => [
	AGENT_EXE,
	"logs",
	"-n",
	String(lines),
];

export const agentSelftestCmd = (): string[] => [
	AGENT_EXE,
	"selftest",
	"--pty",
];

// --- end of the agent CLI contract ---

/** pwsh 7 with a script as -EncodedCommand: no quoting through QGA and the command line. */
function pwshCmd(script: string): string[] {
	return [
		PWSH_EXE,
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}

/** verify.ps1 with `-Name value` parameters; values are UUIDs, digits and plain words. */
function scriptCmd(params: [string, string][]): string[] {
	return [
		PWSH_EXE,
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		GUEST_SCRIPT,
		...params.flatMap(([k, v]) => [`-${k}`, v]),
	];
}

/** Spec 12.6: exit codes of the `shell` path. */
export const SHELL_CASES: readonly {
	id: string;
	script: string;
	want: number;
	stdout?: string;
}[] = [
	{ id: "shell_exit_7", script: "exit 7", want: 7 },
	{ id: "shell_native_exit", script: "cmd /c exit 3", want: 3 },
	{ id: "shell_cmdlet_error", script: "Get-Item C:\\nope", want: 1 },
	{ id: "shell_ok", script: "Write-Output ok", want: 0, stdout: "ok" },
];

const pass = (id: string, ok: boolean, evidence: string): CheckResult => ({
	id,
	status: ok ? "PASS" : "FAIL",
	evidence,
});
const info = (id: string, evidence: string): CheckResult => ({
	id,
	status: "INFO",
	evidence,
});

/**
 * S1 snapshot of the running clone for the fork. VSS holds writes for about 10 s; on a slow
 * host pause + lvcreate + resume can take longer (FreezeBudgetExceededError) or VSS thaws by
 * itself first (autoThawed). Then one retry, then a crash-consistent snapshot with a WARN: the
 * fork checks (marker, DPAPI, name, password) still decide. `track` sees every snapshot that
 * exists, so the caller's cleanup removes it if this throws.
 */
export async function forkSnapshot(
	machines: Pick<VerifyDeps["machines"], "snapshot" | "deleteSnapshot">,
	vmid: number,
	track: (s: SnapshotRef | undefined) => void = () => {},
): Promise<{ snap: SnapshotRef; warn?: CheckResult }> {
	const reasons: string[] = [];
	for (let i = 0; i < 2; i++) {
		try {
			const s = await machines.snapshot(vmid);
			if (!s.autoThawed) return { snap: s };
			track(s);
			reasons.push(
				`VSS auto-thawed before the thaw, frozen ${s.freezeMs ?? "?"} ms`,
			);
			await machines.deleteSnapshot(s);
			track(undefined);
		} catch (err) {
			if (!(err instanceof FreezeBudgetExceededError)) throw err;
			reasons.push(`freeze budget exceeded, frozen ${err.freezeMs ?? "?"} ms`);
		}
	}
	const snap = await machines.snapshot(vmid, { crashConsistent: true });
	return {
		snap,
		warn: {
			id: "vss_snapshot",
			status: "WARN",
			evidence: `quiesced snapshot failed twice (${reasons.join("; ")}); crash-consistent snapshot used instead (slow host: VSS holds writes about 10 s)`,
		},
	};
}

const uuidHex = (s: string) => s.replaceAll("-", "").toLowerCase();
const sameId = (x: string | undefined, y: string) =>
	x !== undefined && x !== "" && uuidHex(x) === uuidHex(y);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0]?.trim() ?? "";
const lastLines = (s: string, n = 5) =>
	s.trim().split(/\r?\n/).slice(-n).join(" | ");

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Computer name of a machine (spec 11.2 p.4): SBX + the last 12 hex digits of its id. */
export function computerNameFor(machineId: string): string {
	return `SBX${uuidHex(machineId).slice(-12).toUpperCase()}`;
}

/** Field of a protojson object under its proto name or its JSON (lowerCamel) name. */
function field(obj: unknown, name: string): unknown {
	if (typeof obj !== "object" || obj === null) return undefined;
	const o = obj as Record<string, unknown>;
	if (name in o) return o[name];
	return o[name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Readiness state names: status.json ("ready") and the protojson enum. */
const isReadyState = (s: string) => s === "ready" || s === "PHASE_STATE_READY";

function identityPhase(phases: unknown): string {
	if (!Array.isArray(phases)) return "";
	return str(
		field(
			phases.find((p) => field(p, "name") === "identity"),
			"state",
		),
	);
}

interface InfoState {
	machineId: string;
	identity: string;
	hostname: string;
	claimed: boolean;
}

/** The parts of System/Info verify uses. */
function infoState(j: unknown): InfoState {
	return {
		machineId: str(field(j, "machine_id")),
		identity: identityPhase(field(j, "readiness")),
		hostname: str(field(j, "hostname")),
		claimed:
			str(field(field(j, "claim"), "sandbox_id")) !== "" ||
			str(field(j, "sandbox_id")) !== "",
	};
}

/** verify.ps1 output: CHECK and TOOLS lines (as verify.sh), `LICENSE <json>` and `FACTS <json>`. */
export function parseWindowsOutput(stdout: string): {
	checks: CheckResult[];
	tools: Record<string, { direct: string; login: string }>;
	license?: unknown;
	facts?: unknown;
} {
	const text = stdout.replaceAll("\r", "");
	const { checks, tools } = parseCheckLines(text);
	const out: ReturnType<typeof parseWindowsOutput> = { checks, tools };
	for (const line of text.split("\n")) {
		for (const tag of ["LICENSE", "FACTS"] as const) {
			if (!line.startsWith(`${tag} `)) continue;
			try {
				const v: unknown = JSON.parse(line.slice(tag.length + 1));
				if (tag === "LICENSE") out.license = v;
				else out.facts = v;
			} catch (err) {
				checks.push(
					pass(
						`verify_ps1_${tag.toLowerCase()}`,
						false,
						`${tag} line is not JSON: ${errorText(err)}`,
					),
				);
			}
		}
	}
	return out;
}

/** Spec 12.6 acceptance: the codes of `exec --shell` against SHELL_CASES. */
export function checkShellContract(
	results: { id: string; exitCode: number; stdout: string }[],
): CheckResult[] {
	return SHELL_CASES.map((c) => {
		const r = results.find((x) => x.id === c.id);
		if (!r) return pass(c.id, false, `${JSON.stringify(c.script)} did not run`);
		const out = r.stdout.trim();
		const ok =
			r.exitCode === c.want && (c.stdout === undefined || out === c.stdout);
		return pass(
			c.id,
			ok,
			`${JSON.stringify(c.script)}: exit ${r.exitCode}, want ${c.want}${c.stdout !== undefined ? `; stdout ${JSON.stringify(out)}, want ${JSON.stringify(c.stdout)}` : ""}`,
		);
	});
}

/** `sbx-agent doctor --json` (spec 15.1 p.6); the service, failure actions and early.json are in verify.ps1. */
export function checkWindowsDoctor(
	doc: unknown,
	expect: { agentVersion: string; machineId: string; tunnelUrl: string },
): CheckResult[] {
	const isReport = typeof doc === "object" && doc !== null;
	const d = (isReport ? doc : {}) as {
		versions?: { current?: string };
		units?: Record<string, string>;
		identity?: { machine_id?: string } | null;
		identity_error?: string;
		tunnel_url?: { url?: string; source?: string };
		status?: { identity?: { state?: string } } | null;
		readiness?: { phases?: unknown } | null;
		test_aids?: string[];
	};
	const version = d.versions?.current;
	const mid = d.identity?.machine_id;
	const state = d.status?.identity?.state ?? identityPhase(d.readiness?.phases);
	const url = d.tunnel_url;
	const svc = d.units?.["sbx-agent"];
	const aids = d.test_aids;
	return [
		pass(
			"agent_version",
			version === expect.agentVersion,
			`current ${version ?? "none"}, manifest ${expect.agentVersion}`,
		),
		pass(
			"agent_identity",
			sameId(mid, expect.machineId) && isReadyState(state),
			`machine_id ${mid ?? `none (${d.identity_error ?? "no identity"})`}, state ${state || "unknown"}, want ${expect.machineId}`,
		),
		pass(
			"agent_tunnel_url",
			url?.url === expect.tunnelUrl && url?.source === "smbios",
			`${url?.url ?? "none"} (source ${url?.source ?? "none"}), want ${expect.tunnelUrl} from smbios`,
		),
		// Assumed: the Windows doctor reports the SCM state of sbx-agent under units.
		svc === undefined
			? info("agent_service_doctor", "not in the report")
			: pass(
					"agent_service_doctor",
					svc === "running" || svc === "active",
					`sbx-agent ${svc}`,
				),
		pass(
			"agent_test_aids",
			isReport &&
				(aids === undefined || (Array.isArray(aids) && aids.length === 0)),
			!isReport ? "no report" : aids?.length ? aids.join(", ") : "none",
		),
	];
}

/** One machine of the fork check. */
export interface WinSide {
	/** smbios uuid the VM was created with. */
	uuid: string;
	/** From verify.ps1 FACTS. */
	computerName: string;
	machineGuid: string;
	/** SHA256 fingerprints of the SSH host keys. */
	hostKeys: string[];
	/** sha256 of a salt and the LSA secret L$sbx_user. */
	lsaHash: string;
	/** System/Info of the running agent. */
	info: { machineId: string; hostname: string; claimed: boolean };
}

/** What B shows of A's data and of its own boot. */
export interface ForkProbe {
	/** Marker file A wrote, as B reads it; null when unreadable. */
	marker: string | null;
	/** DPAPI secret A's user protected, as B's user decrypts it; null on failure. */
	dpapi: string | null;
	/** Boots of B (event 6005 after the snapshot). */
	bootsSince: number | null;
	identityResetLogged: boolean;
}

/** Spec 15.1 p.13 on the fork path (Decision 9): new identity, same data and password. */
export function checkWindowsFork(
	a: WinSide,
	b: WinSide,
	p: ForkProbe,
	expect: { marker: string; dpapi: string },
): CheckResult[] {
	const wantName = computerNameFor(b.uuid);
	const sharedKeys = b.hostKeys.filter((k) => a.hostKeys.includes(k));
	return [
		pass(
			"fork_name",
			b.computerName === wantName &&
				b.info.hostname.toUpperCase() === wantName &&
				a.computerName !== b.computerName,
			`A ${a.computerName}, B ${b.computerName} (agent ${b.info.hostname || "none"}), want ${wantName}`,
		),
		pass(
			"fork_machine_guid",
			sameId(b.machineGuid, b.uuid) && !sameId(a.machineGuid, b.machineGuid),
			`A ${a.machineGuid}, B ${b.machineGuid}, want ${b.uuid}`,
		),
		pass(
			"fork_agent_machine_id",
			sameId(b.info.machineId, b.uuid),
			`agent ${b.info.machineId || "none"}, want ${b.uuid}`,
		),
		pass(
			"fork_host_keys",
			a.hostKeys.length > 0 && b.hostKeys.length > 0 && sharedKeys.length === 0,
			`A ${a.hostKeys.join(" ") || "none"}; B ${b.hostKeys.join(" ") || "none"}`,
		),
		pass(
			"fork_marker",
			p.marker === expect.marker,
			p.marker === null
				? "marker file not readable on B"
				: p.marker === expect.marker
					? "marker file of A present on B"
					: `marker on B ${JSON.stringify(p.marker)}, want ${JSON.stringify(expect.marker)}`,
		),
		pass(
			"fork_dpapi",
			p.dpapi === expect.dpapi,
			p.dpapi === null
				? "the DPAPI blob of A does not decrypt as user on B"
				: p.dpapi === expect.dpapi
					? "the DPAPI blob of A decrypts as user on B"
					: "the DPAPI blob decrypts to another value",
		),
		pass(
			"fork_password_kept",
			a.lsaHash !== "" && a.lsaHash === b.lsaHash,
			`salted sha256 of L$sbx_user: A ${a.lsaHash.slice(0, 16) || "none"}, B ${b.lsaHash.slice(0, 16) || "none"}`,
		),
		pass(
			"fork_one_reboot",
			p.bootsSince === FORK_BOOTS,
			`${p.bootsSince ?? "unknown"} boots of B (event 6005), want ${FORK_BOOTS}: one rename reboot`,
		),
		pass(
			"fork_identity_reset",
			p.identityResetLogged,
			p.identityResetLogged
				? "identity.reset in sbx-agent logs"
				: `no identity.reset in the last ${LOG_LINES} log lines`,
		),
		pass(
			"fork_agent_state",
			a.info.claimed && !b.info.claimed,
			`A claimed ${a.info.claimed}, B claimed ${b.info.claimed}`,
		),
	];
}

/** LICENSE line of verify.ps1. */
interface GuestLicense {
	/** SoftwareLicensingProduct.LicenseStatus by name (Licensed, OOBGrace, ...). */
	status?: string | null;
	description?: string | null;
	graceMinutes?: number | null;
	/** EvaluationEndDate as ISO 8601; null without one. */
	evaluationEnd?: string | null;
	editionId?: string | null;
}

/**
 * Spec 15.1 p.17: the edition must match; an evaluation must activate (`pending` while it has
 * not) and warns under 30 days left, fails under 7. Retail and volume activation is INFO.
 */
export function checkLicense(
	raw: unknown,
	m: Manifest,
	now: number,
): { checks: CheckResult[]; license: LicenseInfo; pending: boolean } {
	const channel = m.license?.channel ?? "retail";
	const l = (
		typeof raw === "object" && raw !== null ? raw : {}
	) as GuestLicense;
	const status = l.status ?? null;
	const end = l.evaluationEnd ? Date.parse(l.evaluationEnd) : Number.NaN;
	// EvaluationEndDate of a product without one is 1601-01-01.
	const hasEnd = Number.isFinite(end) && end > Date.UTC(1700, 0, 1);
	const grace = typeof l.graceMinutes === "number" ? l.graceMinutes : 0;
	let daysRemaining: number | null = null;
	let expiresAt: string | null = null;
	if (channel === "evaluation" && hasEnd) {
		daysRemaining = Math.floor((end - now) / DAY_MS);
		expiresAt = new Date(end).toISOString();
	} else if (grace > 0) {
		daysRemaining = Math.floor(grace / 1440);
		expiresAt = new Date(now + grace * MIN).toISOString();
	}
	const license: LicenseInfo = { status, channel, daysRemaining, expiresAt };
	const want = m.windows?.editionId ?? null;
	const checks: CheckResult[] = [
		pass(
			"license_edition",
			raw !== undefined && want !== null && l.editionId === want,
			raw === undefined
				? "verify.ps1 printed no LICENSE line"
				: `EditionID ${l.editionId ?? "none"}, manifest ${want ?? "none"}`,
		),
	];
	const what = `${status ?? "unknown"}${l.description ? ` (${l.description})` : ""}`;
	if (channel !== "evaluation") {
		checks.push(info("license_status", `${channel}: ${what}`));
		return { checks, license, pending: false };
	}
	const activated = status === "Licensed";
	checks.push(pass("license_status", activated, `evaluation: ${what}`));
	if (activated) {
		const days = `${daysRemaining ?? "unknown"} days left${expiresAt ? `, expires ${expiresAt}` : ""}`;
		if (daysRemaining === null || daysRemaining < 7)
			checks.push(pass("license_days", false, days));
		else if (daysRemaining < 30)
			checks.push(info("license_days", `warning: ${days}`));
		else checks.push(pass("license_days", true, days));
	}
	return { checks, license, pending: !activated };
}

/** Thrown after a FAIL that leaves nothing else to check; verify cleans up and returns. */
class StopVerify extends Error {}

interface WinClone {
	vmid: number;
	uuid: string;
	bs: Buffer;
	smbios: Smbios;
	reserved: boolean;
}

interface CallResult extends ExecResult {
	/** The JSON response; undefined when the call failed. */
	json?: unknown;
}

export async function verifyWindows(
	deps: VerifyDeps,
	m: Manifest,
	o: VerifyOptions = {},
): Promise<VerifyResult> {
	if (m.pveVmid === null) throw new Error("the build has no template VMID");
	const win = deps.windows;
	if (!win) throw new Error("windows verify needs QGA file write and fsfreeze");
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? 2000;
	const uuid = deps.randomUUID ?? randomUUID;
	const { machines, log } = deps;
	const { signal } = o;
	// After a shutdown and a quick start, qmeventd waits up to 30 s for the old QEMU to exit
	// while holding the VM lock, and a stop in that window fails (seen on pve).
	const stopVm = async (vmid: number) => {
		for (let i = 1; ; i++) {
			try {
				return await machines.stop(vmid);
			} catch (err) {
				if (i >= LOCK_TRIES || !LOCK_TIMEOUT_RE.test(errorText(err))) throw err;
				log(`stop VM ${vmid}: ${errorText(err)}; retrying`);
				await sleep(LOCK_RETRY_MS);
			}
		}
	};
	const tunnelUrl = o.connect?.url ?? TEST_TUNNEL_URL;
	const family = familyForTunnelUrl(tunnelUrl);
	const bootTimeoutMs = m.bootTimeoutS * 1000;
	const identity = () => {
		const id = uuid();
		const bs = randomBytes(32);
		return {
			uuid: id,
			bs,
			smbios: { uuid: id, serial: s2SerialPayload(id, bs), family },
		};
	};

	const checks: CheckResult[] = [];
	const add = (...cs: CheckResult[]) => {
		for (const c of cs) {
			checks.push(c);
			log(`${c.status.padEnd(4)}  ${c.id}  ${c.evidence}`);
		}
	};
	const step = (what: string) => {
		signal?.throwIfAborted();
		log(`verify: ${what}`);
	};

	const a = identity();
	let cloneA: WinClone | undefined;
	let cloneB: WinClone | undefined;
	let snap: SnapshotRef | undefined;
	let registered = false;
	let license: LicenseInfo | undefined;
	const boot: VerifyBoot = {
		first: { startToQgaMs: 0, startToIpMs: 0 },
		hardRestart: { startToQgaMs: 0, startToIpMs: 0 },
	};

	const exec = (c: WinClone, cmd: string[], timeoutMs?: number) =>
		deps.io(c.vmid).exec(cmd, timeoutMs !== undefined ? { timeoutMs } : {});
	const userShell = (c: WinClone, script: string, timeoutMs?: number) =>
		exec(c, agentExecCmd({ user: USER, shell: script }), timeoutMs);
	const call = async (
		c: WinClone,
		method: string,
		body: unknown,
	): Promise<CallResult> => {
		const r = await deps.io(c.vmid).exec(agentCallCmd(method), {
			input: JSON.stringify(body),
			timeoutMs: AGENT_TIMEOUT_MS,
		});
		if (r.exitCode !== 0) return r;
		try {
			return { ...r, json: JSON.parse(r.stdout) as unknown };
		} catch {
			return {
				...r,
				exitCode: -1,
				stderr: `not JSON: ${firstLine(r.stdout)}`,
			};
		}
	};
	const callError = (r: ExecResult) =>
		`exit ${r.exitCode}: ${firstLine(r.stderr || r.stdout) || "no output"}`;
	const runScript = (
		c: WinClone,
		params: [string, string][],
		timeoutMs = CHECK_TIMEOUT_MS,
	) => exec(c, scriptCmd(params), timeoutMs);
	const writeScript = (c: WinClone) =>
		win.writeFile(c.vmid, GUEST_SCRIPT, Buffer.from(deps.verifyScript, "utf8"));

	const reserve = async (c: WinClone) => {
		await deps.ramGuard.reserve(c.vmid, SIZE.memoryMb);
		c.reserved = true;
	};
	const release = (c: WinClone) => {
		if (!c.reserved) return;
		deps.ramGuard.release(c.vmid);
		c.reserved = false;
	};

	/** Polls System/Info until the agent runs with this clone's identity ready. */
	const waitAgentReady = async (
		c: WinClone,
		startedAt: number,
		label: string,
	): Promise<number> => {
		// The machine id alone is not enough: the first boot of a clone (setup overwrites the
		// specialize name, R16) and of a fork end with the agent's rename reboot (spec 11.2 p.8).
		const wantName = computerNameFor(c.uuid);
		const deadline = startedAt + bootTimeoutMs;
		let last = "no answer";
		for (;;) {
			signal?.throwIfAborted();
			try {
				const r = await call(c, INFO, {});
				if (r.json !== undefined) {
					const st = infoState(r.json);
					const nameOk = st.hostname.toUpperCase() === wantName;
					if (
						sameId(st.machineId, c.uuid) &&
						isReadyState(st.identity) &&
						nameOk
					) {
						const at = now();
						add(
							pass(
								`${label}agent_ready`,
								true,
								`machine_id ${st.machineId}, hostname ${st.hostname}, identity ready ${at - startedAt} ms after start`,
							),
						);
						return at;
					}
					last = `machine_id ${st.machineId || "none"}, hostname ${st.hostname || "none"}, identity ${st.identity || "unknown"}`;
				} else last = callError(r);
			} catch (err) {
				last = errorText(err);
			}
			if (now() >= deadline) {
				add(
					pass(
						`${label}agent_ready`,
						false,
						`VM ${c.vmid}: not ready ${now() - startedAt} ms after start: ${last}`,
					),
				);
				throw new StopVerify(`VM ${c.vmid}: the agent did not get ready`);
			}
			await sleep(pollMs);
		}
	};

	/** Starts a clone, waits for QGA, the IPv4 and the agent; startToAgentActiveMs = agent ready. */
	const startClone = async (
		c: WinClone,
		label: string,
	): Promise<BootTimes & { startToAgentActiveMs: number }> => {
		const startedAt = now();
		await machines.start(c.vmid);
		const ready = await machines.waitReady(c.vmid, {
			startedAt,
			timeoutMs: bootTimeoutMs,
		});
		const at = await waitAgentReady(c, startedAt, label);
		const times = {
			startToQgaMs: ready.pingAt - startedAt,
			startToIpMs: ready.ipAt - startedAt,
			startToAgentActiveMs: at - startedAt,
		};
		log(
			`VM ${c.vmid}: QGA ${times.startToQgaMs} ms, IPv4 ${ready.ip} ${times.startToIpMs} ms, agent ready ${times.startToAgentActiveMs} ms after start`,
		);
		return times;
	};

	/** Whether the secret file exists, read as SYSTEM (an exec as user is gated by the boot step). */
	const secretFile = async (c: WinClone): Promise<string> => {
		const r = await exec(c, pwshCmd(`Test-Path -LiteralPath '${SECRET_PATH}'`));
		if (r.exitCode !== 0) return `error: ${callError(r)}`;
		return r.stdout.trim() === "True" ? "present" : "absent";
	};

	/** sha256 of the secret env and file as a command of user sees them. */
	const secretProbe = async (
		c: WinClone,
	): Promise<{ env: string; file: string; error?: string }> => {
		const r = await userShell(
			c,
			[
				"$h = { param([string]$s) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant() }",
				"$e = $env:SBX_VERIFY_SECRET",
				`$f = '${SECRET_PATH}'`,
				"Write-Output ('env=' + $(if ($null -eq $e) { 'absent' } else { & $h $e }))",
				"Write-Output ('file=' + $(if (Test-Path -LiteralPath $f) { & $h ([IO.File]::ReadAllText($f)) } else { 'absent' }))",
			].join("; "),
		);
		const kv = (k: string) =>
			new RegExp(`^${k}=(\\S+)`, "m").exec(
				r.stdout.replaceAll("\r", ""),
			)?.[1] ?? "";
		return r.exitCode === 0
			? { env: kv("env"), file: kv("file") }
			: { env: "", file: "", error: callError(r) };
	};

	const facts = async (
		c: WinClone,
		params: [string, string][],
	): Promise<Record<string, unknown>> => {
		const r = await runScript(c, [["Check", "facts"], ...params]);
		const f = parseWindowsOutput(r.stdout).facts;
		if (typeof f !== "object" || f === null) {
			log(
				`verify.ps1 -Check facts on VM ${c.vmid}: exit ${r.exitCode}: ${lastLines(r.stderr || r.stdout)}`,
			);
			return {};
		}
		return f as Record<string, unknown>;
	};

	const side = (
		c: WinClone,
		f: Record<string, unknown>,
		inf: InfoState,
	): WinSide => {
		const keys = f.hostKeys;
		return {
			uuid: c.uuid,
			computerName: str(f.computerName),
			machineGuid: str(f.machineGuid),
			hostKeys: Array.isArray(keys)
				? keys.map(String)
				: typeof keys === "string"
					? [keys]
					: [],
			lsaHash: str(f.lsaHash),
			info: {
				machineId: inf.machineId,
				hostname: inf.hostname,
				claimed: inf.claimed,
			},
		};
	};

	const agentInfo = async (c: WinClone): Promise<InfoState> => {
		const r = await call(c, INFO, {});
		if (r.json === undefined)
			log(`System/Info on VM ${c.vmid}: ${callError(r)}`);
		return infoState(r.json);
	};

	/** Filesystem API as user (spec 12.9): make a directory, stat, move, list, remove. */
	const filesCheck = async (c: WinClone): Promise<CheckResult> => {
		const fileA = `${FILES_DIR}\\a.txt`;
		const fileB = `${FILES_DIR}\\b.txt`;
		const content = "sbx-verify";
		const done: string[] = [];
		const fail = (what: string) =>
			pass("agent_files", false, [...done, what].join("; "));
		const mk = await call(c, FS("MakeDir"), {
			path: FILES_DIR,
			user: USER,
			parents: true,
		});
		if (mk.json === undefined) return fail(`MakeDir: ${callError(mk)}`);
		done.push("MakeDir");
		const wr = await userShell(
			c,
			`Set-Content -NoNewline -LiteralPath '${fileA}' -Value '${content}'`,
		);
		if (wr.exitCode !== 0) return fail(`write as user: ${callError(wr)}`);
		done.push("write as user");
		const st = await call(c, FS("Stat"), { path: fileA, user: USER });
		if (st.json === undefined) return fail(`Stat: ${callError(st)}`);
		// uint64 is a string in protojson.
		const size = Number(field(field(st.json, "info"), "size"));
		if (size !== content.length)
			return fail(`Stat: size ${size}, want ${content.length}`);
		done.push(`Stat size ${size}`);
		const mv = await call(c, FS("Move"), {
			src: fileA,
			dst: fileB,
			user: USER,
		});
		if (mv.json === undefined) return fail(`Move: ${callError(mv)}`);
		const moved = str(field(field(mv.json, "info"), "path"));
		if (moved.toLowerCase() !== fileB.toLowerCase())
			return fail(`Move: path ${moved}, want ${fileB}`);
		done.push("Move");
		const ls = await call(c, FS("List"), { path: FILES_DIR, user: USER });
		if (ls.json === undefined) return fail(`List: ${callError(ls)}`);
		const entries = field(ls.json, "entries");
		const names = Array.isArray(entries)
			? entries.map((e) => str(field(e, "name")))
			: [];
		if (names.join(",") !== "b.txt")
			return fail(`List: ${names.join(", ") || "empty"}, want b.txt`);
		done.push("List");
		const rm = await call(c, FS("Remove"), {
			path: FILES_DIR,
			user: USER,
			recursive: true,
		});
		if (rm.json === undefined) return fail(`Remove: ${callError(rm)}`);
		if (field(rm.json, "existed") !== true)
			return fail("Remove: existed is not true");
		done.push("Remove");
		return pass("agent_files", true, done.join(", "));
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

		step(`cloning template ${m.pveVmid}`);
		const A: WinClone = {
			...a,
			vmid: (await machines.create({ size: SIZE, smbios: a.smbios })).vmid,
			reserved: false,
		};
		cloneA = A;
		await reserve(A);
		step(`booting VM ${A.vmid} (specialize, OOBE, the rename reboot)`);
		const firstStart = now();
		boot.first = await startClone(A, "");
		let firstReadyAt = firstStart + (boot.first.startToAgentActiveMs ?? 0);
		if (o.connect) {
			step("tunnel session");
			const tc = await waitTunnelSession(o.connect.registrar, A.uuid, {
				now,
				sleep,
				pollMs,
				...(signal !== undefined ? { signal } : {}),
			});
			add(tc);
			if (tc.status === "PASS") firstReadyAt = now();
		} else add(info("tunnel_connected", "skipped: no --connect-url"));
		boot.firstBootToAgentReadyMs = firstReadyAt - firstStart;

		step("guest checks (verify.ps1)");
		await writeScript(A);
		const vs = await runScript(
			A,
			[
				["MachineId", A.uuid],
				["ExpectSubnet", EXPECT_SUBNET],
				["EditionId", m.windows?.editionId ?? ""],
				["Build", m.windows?.build ?? ""],
				["Tools", Object.keys(m.tools).join(",")],
				["HostUnixMs", String(now())],
			],
			VERIFY_PS1_TIMEOUT_MS,
		);
		const out = parseWindowsOutput(vs.stdout);
		if (vs.exitCode !== 0 || !/^TOOLS /m.test(vs.stdout))
			add(
				pass(
					"verify_ps1",
					false,
					`exit ${vs.exitCode}: ${lastLines(vs.stderr)}`,
				),
			);
		add(...out.checks);
		add(...checkTools(out.tools, m.tools));
		let lic = checkLicense(out.license, m, now());
		const licenseUntil = now() + LICENSE_WAIT_MS;
		while (lic.pending && now() < licenseUntil) {
			log(
				`licence ${lic.license.status ?? "unknown"}: waiting for the online activation of the evaluation`,
			);
			await sleep(LICENSE_POLL_MS);
			signal?.throwIfAborted();
			const r = await runScript(A, [["Check", "license"]]);
			lic = checkLicense(parseWindowsOutput(r.stdout).license, m, now());
		}
		add(...lic.checks);
		license = lic.license;

		step("agent (sbx-agent doctor)");
		const dr = await exec(A, agentDoctorCmd(), AGENT_TIMEOUT_MS);
		let doc: unknown = null;
		try {
			doc = JSON.parse(dr.stdout);
		} catch {
			log(`sbx-agent doctor: exit ${dr.exitCode}: ${lastLines(dr.stderr)}`);
		}
		add(
			...checkWindowsDoctor(doc, {
				agentVersion: m.agentVersion,
				machineId: A.uuid,
				tunnelUrl,
			}),
		);

		step("agent processes (sbx-agent exec --user user)");
		const shell: { id: string; exitCode: number; stdout: string }[] = [];
		for (const c of SHELL_CASES) {
			const r = await userShell(A, c.script);
			shell.push({ id: c.id, exitCode: r.exitCode, stdout: r.stdout });
		}
		add(...checkShellContract(shell));
		const un = await exec(
			A,
			agentExecCmd({ user: USER, argv: ["cmd", "/c", "echo", "%USERNAME%"] }),
		);
		add(
			pass(
				"agent_username",
				un.exitCode === 0 && un.stdout.trim().toLowerCase() === USER,
				`cmd /c echo %USERNAME%: exit ${un.exitCode}, ${JSON.stringify(un.stdout.trim())}`,
			),
		);
		const np = await exec(
			A,
			agentExecCmd({ user: USER, argv: ["npm", "--version"] }),
		);
		const npmWant = m.tools.npm;
		add(
			pass(
				"agent_npm_argv",
				np.exitCode === 0 &&
					(npmWant
						? firstLine(np.stdout) === npmWant
						: /^\d+\.\d+\.\d+/.test(firstLine(np.stdout))),
				`npm --version (a .cmd through argv): exit ${np.exitCode}, ${JSON.stringify(firstLine(np.stdout || np.stderr))}${npmWant ? `, manifest ${npmWant}` : ""}`,
			),
		);
		const pty = await exec(A, agentSelftestCmd(), AGENT_TIMEOUT_MS);
		add(
			pass(
				"agent_selftest_pty",
				pty.exitCode === 0,
				`exit ${pty.exitCode}: ${lastLines(pty.stdout + pty.stderr, 2)}`,
			),
		);
		add(await filesCheck(A));

		step("secrets (claim, PrepareStop, hard stop)");
		const secretEnv = randomBytes(24).toString("base64url");
		const secretBody = randomBytes(24).toString("base64url");
		const secrets = {
			secret_env: { SBX_VERIFY_SECRET: secretEnv },
			secret_files: [
				{
					name: SECRET_NAME,
					content: Buffer.from(secretBody).toString("base64"),
					mode: 0o600,
				},
			],
		};
		const cl = await call(A, CLAIM, {
			sandbox_id: `sbx-verify-${A.uuid.slice(0, 8)}`,
			hostname: "sbx-verify",
			port_domain: "verify.invalid",
			env: { SBX_VERIFY_ENV: "1" },
			...secrets,
		});
		add(
			pass(
				"secrets_claim",
				cl.json !== undefined,
				cl.json !== undefined ? "claimed" : callError(cl),
			),
		);
		const p1 = await secretProbe(A);
		add(
			pass(
				"secret_env_visible",
				p1.env === sha256(secretEnv),
				p1.error ??
					`sha256 ${p1.env.slice(0, 16) || "none"} in a command of user`,
			),
			pass(
				"secret_file_visible",
				p1.file === sha256(secretBody),
				p1.error ??
					`${SECRET_PATH}: sha256 ${p1.file.slice(0, 16) || "none"} as user`,
			),
		);
		const ps = await call(A, PREPARE_STOP, {});
		add(
			pass(
				"prepare_stop_wiped",
				field(ps.json, "secret_files_wiped") === true,
				ps.json !== undefined
					? `secret_files_wiped ${String(field(ps.json, "secret_files_wiped"))}`
					: callError(ps),
			),
		);
		const afterStop = await secretFile(A);
		add(
			pass(
				"prepare_stop_file_gone",
				afterStop === "absent",
				`${SECRET_PATH} ${afterStop}`,
			),
		);
		const us = await call(A, UPDATE_SECRETS, secrets);
		const again = await secretFile(A);
		add(
			pass(
				"update_secrets_file",
				us.json !== undefined && again === "present",
				us.json !== undefined ? `${SECRET_PATH} ${again}` : callError(us),
			),
		);
		step(`hard stop and restart of VM ${A.vmid}`);
		await stopVm(A.vmid);
		const aRestart = await startClone(A, "secrets_restart_");
		const afterHard = await secretFile(A);
		add(
			pass(
				"hard_stop_secret_wiped",
				afterHard === "absent",
				`${SECRET_PATH} ${afterHard} once the agent is ready (early wipes it)`,
			),
		);
		// Leaves no applied secrets behind before the fork snapshot.
		const cleared = await call(A, UPDATE_SECRETS, {});
		add(
			pass(
				"secrets_reset",
				cleared.json !== undefined,
				cleared.json !== undefined
					? "empty secret set applied"
					: callError(cleared),
			),
		);

		step("VSS freeze and thaw (QGA)");
		const freezeStart = now();
		let frozen = false;
		let during = "unknown";
		let freezeError = "";
		try {
			await win.fsfreezeFreeze(A.vmid);
			frozen = true;
			during = await win.fsfreezeStatus(A.vmid);
		} catch (err) {
			freezeError = errorText(err);
		} finally {
			// A freeze that threw may have frozen the volumes anyway: always thaw. "Not frozen"
			// after a failed freeze is expected and not reported.
			const t = await win.fsfreezeThaw(A.vmid).catch((err: unknown) => {
				if (frozen) freezeError ||= `thaw: ${errorText(err)}`;
			});
			if (frozen && t?.autoThawed)
				freezeError ||= "VSS had already thawed by itself before the thaw";
		}
		const freezeMs = now() - freezeStart;
		const after = await win.fsfreezeStatus(A.vmid).catch(errorText);
		add(
			pass(
				"vss_freeze",
				freezeError === "" &&
					during === "frozen" &&
					after === "thawed" &&
					freezeMs <= FREEZE_LIMIT_MS,
				`${freezeError ? `${freezeError}; ` : ""}status ${during} while frozen, ${after} after thaw, freeze to thaw ${freezeMs} ms (limit ${FREEZE_LIMIT_MS})`,
			),
		);
		const ve = parseWindowsOutput(
			(await runScript(A, [["Check", "vss_events"]])).stdout,
		).checks;
		add(...ve);
		if (!ve.some((c) => c.id === "vss_events"))
			add(pass("vss_events", false, "verify.ps1 printed nothing"));

		step("fork preparation: marker file, DPAPI secret, facts of A");
		const marker = randomBytes(12).toString("hex");
		const dpapiPlain = randomBytes(12).toString("hex");
		const mw = await userShell(
			A,
			`Set-Content -NoNewline -LiteralPath '${MARKER_PATH}' -Value '${marker}'`,
		);
		const dw = await userShell(
			A,
			`ConvertTo-SecureString '${dpapiPlain}' -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline -LiteralPath '${DPAPI_PATH}'`,
		);
		add(
			pass(
				"fork_prepare",
				mw.exitCode === 0 && dw.exitCode === 0,
				`marker as user: exit ${mw.exitCode}; DPAPI blob as user: exit ${dw.exitCode}${dw.exitCode !== 0 ? ` (${firstLine(dw.stderr)})` : ""}`,
			),
		);
		const salt = randomBytes(16).toString("hex");
		const sideA = side(A, await facts(A, [["Salt", salt]]), await agentInfo(A));

		step(`snapshot of VM ${A.vmid} (QGA VSS hook)`);
		const taken = await forkSnapshot(machines, A.vmid, (s) => {
			snap = s;
		});
		snap = taken.snap;
		if (taken.warn) add(taken.warn);
		boot.freezeMs = snap.freezeMs ?? freezeMs;
		const since = new Date(snap.createdAt).toISOString();
		step(`shutting down VM ${A.vmid}`);
		await machines.shutdown(A.vmid, SHUTDOWN_TIMEOUT_S);
		release(A);

		step("fork B with a new identity");
		const b = identity();
		const B: WinClone = {
			...b,
			vmid: (await machines.fork(snap, { size: SIZE, smbios: b.smbios })).vmid,
			reserved: false,
		};
		cloneB = B;
		await reserve(B);
		step(`booting fork VM ${B.vmid} (identity change)`);
		const forkBoot = await startClone(B, "fork_");
		boot.identityChangeBootMs = forkBoot.startToAgentActiveMs;
		add(
			info(
				"fork_boot_ms",
				`${boot.identityChangeBootMs} ms start to agent ready`,
			),
		);
		await writeScript(B);
		const fB = await facts(B, [
			["Salt", salt],
			["Since", since],
		]);
		const sideB = side(B, fB, await agentInfo(B));
		const mr = await userShell(
			B,
			`Get-Content -Raw -LiteralPath '${MARKER_PATH}'`,
		);
		const dr2 = await userShell(
			B,
			`$s = Get-Content -Raw -LiteralPath '${DPAPI_PATH}' | ConvertTo-SecureString; ConvertFrom-SecureString -SecureString $s -AsPlainText`,
		);
		// Spec 15.1 p.13: autologon still works on the fork (the password did not change).
		const al = parseWindowsOutput(
			(await runScript(B, [["Check", "autologon"]])).stdout,
		).checks.map((c) => ({ ...c, id: `fork_${c.id}` }));
		add(...al);
		if (!al.some((c) => c.id === "fork_autologon_session"))
			add(pass("fork_autologon_session", false, "verify.ps1 printed nothing"));
		const lg = await exec(B, agentLogsCmd(LOG_LINES));
		const logs = lg.stdout.toLowerCase();
		add(
			...checkWindowsFork(
				sideA,
				sideB,
				{
					marker: mr.exitCode === 0 ? mr.stdout.trim() : null,
					dpapi: dr2.exitCode === 0 ? dr2.stdout.trim() : null,
					bootsSince: typeof fB.bootsSince === "number" ? fB.bootsSince : null,
					identityResetLogged:
						logs.includes("identity.reset") ||
						// Temporary fallback until the agent logs identity.reset on Windows.
						(logs.includes("identity applied") && logs.includes(B.uuid)),
				},
				{ marker, dpapi: dpapiPlain },
			),
		);

		step(`shutdown and boot of VM ${B.vmid}`);
		await machines.shutdown(B.vmid, SHUTDOWN_TIMEOUT_S);
		const normal = await startClone(B, "fork_reboot_");
		boot.bootToAgentReadyMs = normal.startToAgentActiveMs;
		step(`hard stop and restart of VM ${B.vmid}`);
		await stopVm(B.vmid);
		const hard = await startClone(B, "fork_hard_stop_");
		boot.hardRestart = hard;
		boot.hardStopRestartMs = hard.startToAgentActiveMs;
		const limit = (boot.bootToAgentReadyMs ?? 0) + HARD_STOP_SLACK_MS;
		add(
			pass(
				"hard_stop_restart",
				(boot.hardStopRestartMs ?? Number.POSITIVE_INFINITY) <= limit,
				`agent ready ${boot.hardStopRestartMs} ms after a hard stop, ${boot.bootToAgentReadyMs} ms after a shutdown, limit ${limit} ms`,
			),
		);
		add(
			info(
				"boot_times",
				`first boot ${boot.firstBootToAgentReadyMs} ms, identity change ${boot.identityChangeBootMs} ms, boot ${boot.bootToAgentReadyMs} ms, hard stop ${boot.hardStopRestartMs} ms (A: ${aRestart.startToAgentActiveMs} ms), freeze ${boot.freezeMs} ms`,
			),
		);
	} catch (err) {
		if (!(err instanceof StopVerify)) failure = err;
	}

	// Cleanup: fork, snapshot, clone, registration. Every part is attempted; delete runs
	// verifyGone (VM, config, IPAM, LVs, DHCP lease).
	const problems: string[] = [];
	// VM locks time out now and then ("can't lock file ... got timeout", seen on pve; see
	// stopVm): each cleanup step is tried three times, 10 s apart.
	const attempt = async (what: string, fn: () => Promise<void>) => {
		for (let i = 1; ; i++) {
			try {
				await fn();
				return;
			} catch (err) {
				if (i >= CLEANUP_TRIES) {
					problems.push(`${what}: ${errorText(err)}`);
					return;
				}
				log(`cleanup ${what}: ${errorText(err)}; retrying`);
				await sleep(CLEANUP_RETRY_MS);
			}
		}
	};
	if (o.keep) {
		log(
			`--keep: leaving ${[cloneA, cloneB]
				.filter((c) => c !== undefined)
				.map((c) => `VM ${c.vmid}`)
				.join(", ")}${snap ? `, snapshot ${snap.id}` : ""}`,
		);
	} else {
		for (const c of [cloneB, cloneA]) {
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
	for (const c of [cloneB, cloneA]) if (c) release(c);
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
		kvm: { available: false, reason: "not checked on windows" },
		fork: {
			ok: forkChecks.length > 0 && forkChecks.every((c) => c.status !== "FAIL"),
		},
		...(license !== undefined ? { license } : {}),
		at: new Date(now()).toISOString(),
	};
}
