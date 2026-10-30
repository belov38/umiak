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

export interface WindowsFacts {
	/** `/IMAGE/NAME` installed from the ISO. */
	edition: string;
	/** EditionID of the installed system, e.g. Professional; null until the seal stage. */
	editionId: string | null;
	/** CurrentBuild, e.g. 26300. */
	build: string | null;
	/** Update build revision. */
	ubr: number | null;
	/** DisplayVersion, e.g. 25H2. */
	displayVersion: string | null;
	family: "client" | "server";
	isoFile: string;
	/** sha256 of the user's ISO as computed on the node. */
	isoSha256: string;
	virtioWinVersion: string;
	openssh: { source: "inbox" | "github"; version: string | null };
	/** Provisioned Appx packages of the removal list that are gone. */
	appxRemoved: string[];
	options: { vsBuildtools: boolean };
}

export interface LicenseInfo {
	status: string | null;
	channel: "retail" | "evaluation" | "volume";
	daysRemaining: number | null;
	expiresAt: string | null;
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
	/** Linux: the cloud image. */
	base?: {
		distro: string;
		release: string;
		flavor: string;
		serial: string;
		sha256: string;
	};
	/** Linux: the apt snapshot. */
	apt?: { snapshot: string };
	/** Windows: install media and facts of the sealed image (spec S9 section 15.2). */
	windows?: WindowsFacts;
	/** Windows: licence state; `channel` from versions.toml, the rest is filled by verify. */
	license?: LicenseInfo;
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
	/** Template hardware: recipe `hw` plus `cloudinit`; windows: `machine` pinned at build time. */
	hw: Record<string, string | boolean>;
	/**
	 * Slot -> disk options. Windows also records `index`: k of the template's
	 * base-<vmid>-disk-<k> (spec S9 section 7 p.8).
	 */
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
