import { expect, it } from "vitest";
import {
	guestDhcp,
	VENDOR_NETWORK_FILE,
	waitGuestOnline,
} from "../src/vendor-tools.ts";

const io = (dnsAfter: number) => {
	const commands: string[][] = [];
	let lookups = 0;
	return {
		commands,
		io: {
			exec: async (cmd: string[]) => {
				commands.push(cmd);
				if (cmd[0] === "getent")
					return {
						exitCode: ++lookups > dnsAfter ? 0 : 2,
						stdout: "",
						stderr: "",
					};
				return { exitCode: 0, stdout: "ens18 routable", stderr: "" };
			},
			readFile: async () => Buffer.alloc(0),
			ping: async () => true,
		},
	};
};

it("enables runtime-only DHCP and waits until the guest resolves names", async () => {
	const g = io(2);
	await waitGuestOnline(g.io, 1);
	const setup = g.commands[0] ?? [];
	expect(setup).toContain(VENDOR_NETWORK_FILE);
	expect(VENDOR_NETWORK_FILE.startsWith("/run/")).toBe(true);
	expect(setup.join(" ")).toContain("DHCP=ipv4");
	expect(g.commands.filter((c) => c[0] === "getent")).toHaveLength(3);
});

it("fails with network status when DNS never comes up", async () => {
	const g = io(Number.POSITIVE_INFINITY);
	let t = 0;
	await expect(waitGuestOnline(g.io, 1, 10, () => (t += 6))).rejects.toThrow(
		/no network within .*ens18 routable/,
	);
});

it("removes the runtime DHCP config when going offline", async () => {
	const g = io(0);
	await guestDhcp(g.io, false);
	expect(g.commands[0]?.join(" ")).toContain('rm -f "$1"');
	expect(g.commands[0]).toContain(VENDOR_NETWORK_FILE);
});
