import type { GuestIo } from "./runner.ts";
import { runStep } from "./runner.ts";
import { writeGuestFile } from "./seal.ts";

export interface VendorTool {
	id: string;
	name: string;
	version: string;
	sha256: string;
	installer: string;
}

/** These payloads are fetched on the install's node, never captured in a layer. */
export const VENDOR_TOOLS = [
	{
		id: "claude-code",
		name: "Claude Code",
		version: "2.1.314",
		// Anthropic's published linux-x64 checksum in this release's manifest.json.
		sha256: "4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594",
		installer: "https://claude.ai/install.sh",
	},
	{
		id: "bun",
		name: "Bun",
		version: "1.4.4",
		sha256: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
		installer:
			"https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip",
	},
	{
		id: "opencode",
		name: "OpenCode",
		version: "1.19.5",
		sha256: "588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a",
		installer:
			"https://github.com/anomalyco/opencode/releases/download/v1.19.5/opencode-linux-x64.tar.gz",
	},
] as const satisfies readonly VendorTool[];

export interface VendorToolRecord {
	id: string;
	name: string;
	requestedVersion: string;
	requestedSha256: string;
	checksumSubject: "installed-binary" | "release-archive";
	installer: string;
	status: "installed" | "failed";
	vendorInstalled: true;
	partOfSignedLayer: false;
	version?: string;
	sha256?: string;
	warning?: string;
	startedAt: string;
	durationS: number;
}

export class VendorIsolationError extends Error {}

export async function installVendorTools(deps: {
	network(online: boolean): Promise<void>;
	install(tool: VendorTool): Promise<{ version: string; sha256: string }>;
	log(line: string): void;
	now?: () => number;
}): Promise<VendorToolRecord[]> {
	const records: VendorToolRecord[] = [];
	const now = deps.now ?? Date.now;
	try {
		for (const tool of VENDOR_TOOLS) {
			const start = now();
			const record: VendorToolRecord = {
				id: tool.id,
				name: tool.name,
				requestedVersion: tool.version,
				requestedSha256: tool.sha256,
				checksumSubject:
					tool.id === "claude-code" ? "installed-binary" : "release-archive",
				installer: tool.installer,
				status: "failed",
				vendorInstalled: true,
				partOfSignedLayer: false,
				startedAt: new Date(start).toISOString(),
				durationS: 0,
			};
			deps.log(
				`-- vendor-tools: ${tool.name} (online, outside the signed layer)`,
			);
			try {
				await deps.network(true);
				const result = await deps.install(tool);
				if (result.version !== tool.version || result.sha256 !== tool.sha256)
					throw new Error(
						"installed version or vendor checksum did not match the pin",
					);
				Object.assign(record, result, { status: "installed" });
			} catch (error) {
				if (error instanceof VendorIsolationError) throw error;
				const reason = (error instanceof Error ? error.message : String(error))
					.replace(/[\r\n]+/g, " ")
					.slice(0, 500);
				record.warning = `${tool.name} not installed: ${reason}`;
				deps.log(record.warning);
			}
			record.durationS = (now() - start) / 1000;
			deps.log(
				`-- vendor-tools: ${tool.name} ${record.status} (${record.durationS.toFixed(1)}s)`,
			);
			records.push(record);
		}
	} finally {
		// Vendor failure is tolerated; losing isolation is not. Do not seal with a live NIC.
		await deps.network(false);
	}
	return records;
}

export function vendorInstallScript(tool: VendorTool): string {
	if (
		!["claude-code", "bun", "opencode"].includes(tool.id) ||
		!/^\d+\.\d+\.\d+$/.test(tool.version) ||
		!/^[a-f0-9]{64}$/.test(tool.sha256)
	)
		throw new Error("unsupported vendor tool pin");
	if (tool.id === "bun") return bunInstallScript(tool);
	if (tool.id === "opencode") return opencodeInstallScript(tool);
	return `#!/bin/bash
set -euo pipefail
work=$(mktemp -d)
chmod 0755 "$work"
cleanup() {
 rm -rf "$work"
}
trap cleanup EXIT
curl --proto '=https' --proto-redir '=https' --location --fail --silent --show-error --connect-timeout 15 --max-time 120 --retry 3 --retry-max-time 180 --retry-delay 2 '${tool.installer}' -o "$work/install.sh"
chmod 0644 "$work/install.sh"
timeout --kill-after=10s 600s runuser -u user -- env HOME=/home/user DISABLE_AUTOUPDATER=1 bash "$work/install.sh" '${tool.version}'
binary='/home/user/.local/share/claude/versions/${tool.version}'
printf '%s  %s\\n' '${tool.sha256}' "$binary" | sha256sum --check --status
actual=$(timeout 30s runuser -u user -- env HOME=/home/user DISABLE_AUTOUPDATER=1 "$binary" --version)
[[ "$actual" == '${tool.version} (Claude Code)' ]]
ln -sfn "$binary" /usr/local/bin/claude
# Disable automatic per-sandbox downloads. Users may still explicitly update later.
install -d -m 0755 /etc/profile.d
printf '%s\\n' 'export DISABLE_AUTOUPDATER=1' >/etc/profile.d/umiak-vendor-tools.sh
if ! grep -q '^DISABLE_AUTOUPDATER=' /etc/environment; then
 printf '%s\\n' 'DISABLE_AUTOUPDATER=1' >>/etc/environment
fi
`;
}

/** A separate transient unit with its own log, timeout and process-group cleanup. */
export async function installGuestVendorTool(
	io: GuestIo,
	tool: VendorTool,
	log: (line: string) => void,
	pollMs?: number,
): Promise<{ version: string; sha256: string }> {
	const name = `vendor-${tool.id}`;
	const script = `/var/lib/umiak-build/${name}.sh`;
	await writeGuestFile(io, script, vendorInstallScript(tool));
	let installed = false;
	try {
		await runStep(io, {
			name,
			script,
			log,
			pollMs: pollMs ?? 2000,
			timeoutMs: 12 * 60_000,
		});
		installed = true;
		return { version: tool.version, sha256: tool.sha256 };
	} finally {
		await stopVendorInstaller(io, name, installed);
	}
}

async function stopVendorInstaller(
	io: GuestIo,
	name: string,
	installed: boolean,
): Promise<void> {
	const stopped = await io.exec([
		"systemctl",
		"stop",
		`umiak-build-${name}.service`,
	]);
	// --collect removes completed units; stop's missing-unit error is harmless.
	if (
		stopped.exitCode !== 0 &&
		!/not loaded|not found|does not exist/i.test(stopped.stderr)
	)
		throw new VendorIsolationError("could not stop the vendor installer");
	if (!installed) {
		const cleaned = await io.exec([
			"bash",
			"-c",
			name === "vendor-claude-code"
				? "unlink /usr/local/bin/claude 2>/dev/null || true\nrm -rf /home/user/.local/share/claude /home/user/.local/bin/claude"
				: name === "vendor-bun"
					? "rm -f /usr/local/bin/bun /usr/local/bin/bunx"
					: "rm -f /usr/local/bin/opencode",
		]);
		if (cleaned.exitCode !== 0)
			throw new VendorIsolationError(
				"could not remove the incomplete vendor installation",
			);
	}
}

function bunInstallScript(tool: VendorTool): string {
	return `#!/bin/bash
set -euo pipefail
work=$(mktemp -d)
cleanup() {
 rm -rf "$work"
}
trap cleanup EXIT
fetch() {
 curl --proto '=https' --proto-redir '=https' --location --fail --silent --show-error --connect-timeout 15 --max-time 180 --retry 3 --retry-max-time 240 --retry-delay 2 "$1" -o "$2"
}
fetch 'https://github.com/oven-sh/bun/releases/download/bun-v${tool.version}/SHASUMS256.txt' "$work/SHASUMS256.txt"
fetch '${tool.installer}' "$work/bun.zip"
expected=$(awk '$2=="bun-linux-x64.zip" {print $1}' "$work/SHASUMS256.txt")
[ "$expected" = '${tool.sha256}' ]
printf '%s  %s\\n' "$expected" "$work/bun.zip" | sha256sum --check --status
unzip -p "$work/bun.zip" bun-linux-x64/bun >"$work/bun"
chmod 0755 "$work/bun"
[ "$(timeout 30s "$work/bun" --version)" = '${tool.version}' ]
install -m 0755 "$work/bun" /usr/local/bin/bun
ln -sfn bun /usr/local/bin/bunx
`;
}

function opencodeInstallScript(tool: VendorTool): string {
	return `#!/bin/bash
set -euo pipefail
work=$(mktemp -d)
cleanup() {
 rm -rf "$work"
}
trap cleanup EXIT
curl --proto '=https' --proto-redir '=https' --location --fail --silent --show-error --connect-timeout 15 --max-time 180 --retry 3 --retry-max-time 240 --retry-delay 2 '${tool.installer}' -o "$work/opencode.tar.gz"
printf '%s  %s\\n' '${tool.sha256}' "$work/opencode.tar.gz" | sha256sum --check --status
python3 -I - "$work/opencode.tar.gz" "$work/opencode" <<'PYVENDOR'
import sys,tarfile,shutil
with tarfile.open(sys.argv[1]) as archive:
 members=[m for m in archive.getmembers() if m.name.removeprefix('./')=='opencode' and m.isfile() and m.size<1024**3]
 if len(members)!=1: sys.exit('vendor archive has no unique opencode binary')
 with archive.extractfile(members[0]) as source, open(sys.argv[2],'wb') as target: shutil.copyfileobj(source,target)
PYVENDOR
chmod 0755 "$work/opencode"
[ "$(timeout 30s "$work/opencode" --version)" = '${tool.version}' ]
install -m 0755 "$work/opencode" /usr/local/bin/opencode
`;
}
