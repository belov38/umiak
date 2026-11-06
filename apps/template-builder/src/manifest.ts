// Build manifest (spec S5 section 11) and verification results (section 10)

export type BuildStatus = "building" | "ready" | "failed" | "retired";

export interface CheckResult {
	id: string;
	/** WARN: degraded but not a failure (only host-side checks use it). */
	status: "PASS" | "FAIL" | "INFO" | "WARN";
	evidence: string;
}

export interface BootTimes {
	startToQgaMs: number;
	startToIpMs: number;
	startToAgentActiveMs?: number;
}

/** Boot timings of verify (spec S5 section 10; windows: spec S9 section 16). */
export interface VerifyBoot {
	first: BootTimes;
	hardRestart: BootTimes;
	/** Windows: start of a template clone to agent ready (and tunnel connected with a connect URL). */
	firstBootToAgentReadyMs?: number;
	/** Windows: start after a shutdown to agent ready. */
	bootToAgentReadyMs?: number;
	/** Windows: start after a hard stop to agent ready. */
	hardStopRestartMs?: number;
	/** Windows: start of a fork to agent ready, the rename reboot included. */
	identityChangeBootMs?: number;
	/** Windows: QGA VSS freeze to thaw of the snapshot. */
	freezeMs?: number;
}

export interface VerifyResult {
	ok: boolean;
	checks: CheckResult[];
	boot: VerifyBoot;
	kvm: { available: boolean; reason?: string };
	fork: { ok: boolean };
	/** Windows: licence state of the clone (goes to the manifest's `license`). */
	license?: LicenseInfo;
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
	/**
	 * What the build checked on the boot after the offline WinPE stage: services with Start=4,
	 * services without a key, and the last line of umiak-offline.log.
	 */
	offline?: { services: string[]; missing: string[]; log: string };
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
	/** Durable control-plane job identity, absent for standalone CLI builds. */
	nodeBuildJobId?: string;
	/** Signed offline input release used to customize the official cloud base locally. */
	offlineLayer?: {
		version: string;
		channel: "stable" | "edge";
		manifestSha256: string;
		inventorySha256: string;
		sourceCommit: string;
		verifyScript: string;
	};
	templateSlug: string;
	/** YYYYMMDD.n */
	version: string;
	os: "linux" | "windows";
	desktopMarker?: "umiak-desktop";
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
	/** Desktop artifact pins and upstream sources (S10, including GPL source offers). */
	desktop?: {
		pins: import("./recipe.ts").Versions["desktop"];
		sources: Record<string, string>;
	};
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
	/** When `umiak-tpl retire` marked the build. */
	retiredAt?: string;
}
