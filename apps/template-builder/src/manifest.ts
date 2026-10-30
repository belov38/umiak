// Build manifest (spec S5 section 11) and verification results (section 10)

export type BuildStatus = "building" | "ready" | "failed";

export interface CheckResult {
	id: string;
	status: "PASS" | "FAIL" | "INFO";
	evidence: string;
}

export interface BootTimes {
	startToQgaMs: number;
	startToIpMs: number;
	startToAgentActiveMs?: number;
}

export interface VerifyResult {
	ok: boolean;
	checks: CheckResult[];
	boot: { first: BootTimes; hardRestart: BootTimes };
	kvm: { available: boolean; reason?: string };
	fork: { ok: boolean };
	at: string;
}

export interface BuildError {
	stage: string;
	step?: string;
	message: string;
	/** Last lines of the failed step's log. */
	tail?: string[];
}

export interface Manifest {
	/** UUIDv7. */
	buildId: string;
	templateSlug: string;
	/** YYYYMMDD.n */
	version: string;
	os: "linux" | "windows";
	status: BuildStatus;
	node: string;
	storage: string;
	/** null until the stage `vm` leased a VMID. */
	pveVmid: number | null;
	vmName: string;
	gitCommit: string;
	recipeDigest: string;
	base: {
		distro: string;
		release: string;
		flavor: string;
		serial: string;
		sha256: string;
	};
	apt: { snapshot: string };
	/** `uname -r` of the sealed image. */
	kernel: string | null;
	/** First line of `systemctl --version`. */
	systemd: string | null;
	/** dpkg package name -> version. */
	packages: Record<string, string>;
	/** Tool -> first line of its version output; null when the command is missing. */
	tools: Record<string, string | null>;
	agentVersion: string;
	defaultTunnelUrl: string | null;
	/** Template hardware: recipe `hw` plus `cloudinit`. */
	hw: Record<string, string | boolean>;
	diskLayout: Record<string, Record<string, string>>;
	/** Thin pool space the template disk takes, GiB (spec section 20: image size). */
	diskUsedGiB?: number;
	bootTimeoutS: number;
	buildMemoryMb: number;
	startedAt: string;
	finishedAt: string | null;
	durationS: number | null;
	verify?: VerifyResult;
	error?: BuildError;
}
