import { expect, it } from "vitest";
import { parse } from "yaml";
import { renderOfflineSeed } from "../src/offline-seed.ts";

it("boots only the authenticated local layer and installs QGA without online cloud-init packages", () => {
	const files = renderOfflineSeed("a".repeat(24));
	const user = parse(String(files.get("user-data")));
	expect(user.package_update).toBe(false);
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
