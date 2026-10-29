import ssh2 from "ssh2";

/**
 * ed25519 key pair for SSH tests. ssh2's generator occasionally writes a private key its own parser
 * rejects ("Malformed OpenSSH private key"), so keep only keys that parse.
 */
export function sshKeyPair(): { private: string; public: string } {
	for (;;) {
		const k = ssh2.utils.generateKeyPairSync("ed25519");
		if (!(ssh2.utils.parseKey(k.private) instanceof Error)) return k;
	}
}
