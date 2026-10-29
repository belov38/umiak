import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";
import { sshKeyPair } from "./ssh-keys.ts";

describe("sshKeyPair", () => {
	it("always returns a private key ssh2 can parse", () => {
		// ssh2's own ed25519 generator yields an unparsable key about once in 200.
		let bad = 0;
		for (let i = 0; i < 3000; i++)
			if (ssh2.utils.parseKey(sshKeyPair().private) instanceof Error) bad++;
		expect(bad).toBe(0);
	});
});
