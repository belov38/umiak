import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { SEED_CLI_PATH } from "./platform-tools.ts";

/**
 * Small NoCloud seed; the separately authenticated media carries every build input.
 * `apt.preserve_sources_list` stops cloud-init's apt module (config stage, after
 * bootcmd) from rewriting the default network sources that the offline
 * bootstrap just removed.
 */
export function renderOfflineSeed(
	jobId: string,
	umiakCli?: string,
): Map<string, string | Buffer> {
	if (!/^[a-f0-9]{24}$/.test(jobId))
		throw Error("Invalid offline build job identity");
	const files = new Map<string, string | Buffer>([
		[
			"meta-data",
			stringify({
				"instance-id": `umiak-layer-${jobId}`,
				"local-hostname": "umiak-build",
			}),
		],
		["network-config", stringify({ version: 2, ethernets: {} })],
		[
			"user-data",
			`#cloud-config\n${stringify({ users: [], disable_root: true, ssh_pwauth: false, package_update: false, package_upgrade: false, packages: [], apt: { preserve_sources_list: true }, bootcmd: [["bash", "-euc", "mkdir -p /mnt/layer; mount -o ro LABEL=umiak-layer /mnt/layer; bash /mnt/layer/build/offline-bootstrap.sh"]] })}`,
		],
	]);
	// The installed release CLI rides on the seed; installPlatformCli verifies its hash in the guest.
	if (umiakCli !== undefined) files.set(SEED_CLI_PATH, readFileSync(umiakCli));
	return files;
}
