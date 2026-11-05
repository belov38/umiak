import { stringify } from "yaml";

/** Small NoCloud seed; the separately authenticated media carries every build input. */
export function renderOfflineSeed(jobId: string): Map<string, string | Buffer> {
	if (!/^[a-f0-9]{24}$/.test(jobId))
		throw Error("Invalid offline build job identity");
	return new Map([
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
			`#cloud-config\n${stringify({ users: [], disable_root: true, ssh_pwauth: false, package_update: false, package_upgrade: false, packages: [], bootcmd: [["bash", "-euc", "mkdir -p /mnt/layer; mount -o ro LABEL=umiak-layer /mnt/layer; bash /mnt/layer/build/offline-bootstrap.sh"]] })}`,
		],
	]);
}
