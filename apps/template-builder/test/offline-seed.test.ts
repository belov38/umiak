import { expect, it } from "vitest";
import { parse } from "yaml";
import { renderOfflineSeed } from "../src/offline-seed.ts";

it("boots only the authenticated local layer and installs QGA without online cloud-init packages", () => {
	const files = renderOfflineSeed("a".repeat(24));
	const user = parse(String(files.get("user-data")));
	expect(user.package_update).toBe(false);
	expect(user.apt).toEqual({ preserve_sources_list: true });
	expect(user.packages).toEqual([]);
	expect(user.bootcmd[0]).toEqual([
		"bash",
		"-euc",
		expect.stringContaining("LABEL=umiak-layer"),
	]);
	expect(user.bootcmd[0][2]).toContain("/mnt/layer/build/offline-bootstrap.sh");
	expect(String(files.get("user-data"))).not.toMatch(
		/https?:|tunnel|trust\/|ssh_authorized_keys/,
	);
	expect(files.size).toBe(3);
	expect(() => renderOfflineSeed("bad\nidentity")).toThrow();
});

it("never starts services synchronously from the init-local bootstrap", async () => {
	const { readFile } = await import("node:fs/promises");
	const script = await readFile(
		new URL(
			"../../../infra/templates/linux/offline-bootstrap.sh",
			import.meta.url,
		),
		"utf8",
	);
	// bootcmd runs inside cloud-init-local; qemu-guest-agent is ordered after
	// early boot, so `enable --now`/`start` without --no-block deadlocks the VM.
	const code = script
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	expect(code).not.toMatch(
		/systemctl\s+(?:enable\s+--now|start(?![^\n]*--no-block))/,
	);
	expect(code).toMatch(/systemctl start --no-block qemu-guest-agent/);
});
