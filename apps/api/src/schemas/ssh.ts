// SSH (S7 §11.3): how to connect to a sandbox, short-lived login
// certificates, and the SSH keys of a person.
import { z } from "@hono/zod-openapi";
import { SSH_KEY_TYPES } from "@umiak/auth";
import { extensibleEnum } from "../openapi/registry.ts";
import { NO_CONTROL_CHARS, NullableTimestamp, Timestamp } from "./common.ts";

/** Longest accepted key line; a 16384-bit RSA key is ~2.8 KB. */
const MAX_KEY_LINE = 16_384;

const PublicKeyLine = z
	.string()
	.min(1)
	.max(MAX_KEY_LINE)
	.openapi({
		description:
			"OpenSSH public key line: ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa of at " +
			"least 3072 bits; not a certificate",
		example:
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop",
	});

const connectFields = {
	host: z.string().openapi({ example: "ssh.example.com" }),
	port: z.int().openapi({ example: 22 }),
	username: z.string().openapi({
		description: "SSH user name: the slug of the sandbox",
		example: "quiet-otter-lamp",
	}),
	knownHosts: z.array(z.string()).openapi({
		description:
			"`known_hosts` lines of the gateway host keys, the same for every sandbox " +
			"(`[host]:port ...` when the port is not 22)",
		example: ["ssh.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."],
	}),
};

export const SshAccessSchema = z
	.object({
		...connectFields,
		loginUser: z.string().openapi({
			description: "User of the guest OS the session runs as (template)",
			example: "user",
		}),
		command: z.string().openapi({
			example: "ssh quiet-otter-lamp@ssh.example.com",
		}),
		hasKeys: z.boolean().openapi({
			description:
				"The person has registered SSH keys (always false for a team key, which uses certificates)",
		}),
	})
	.openapi("SshAccess");

export const SshCertificateRequest = z
	.strictObject({ publicKey: PublicKeyLine })
	.openapi("SshCertificateRequest");

export const SshCertificateSchema = z
	.object({
		certificate: z.string().openapi({
			description:
				"OpenSSH user certificate line; save it next to the private key as `<key>-cert.pub`",
		}),
		principal: z.string().openapi({
			description: "The only principal: the sandbox id",
			example: "sb_01jbx2v7d3m6c8q9w0e4r5t6y7",
		}),
		validAfter: Timestamp,
		validBefore: Timestamp.openapi({
			description: "Checked only when logging in: an open session lasts longer",
		}),
		...connectFields,
	})
	.openapi("SshCertificate");

export const SshKeyParams = z.object({
	key: z.string().openapi({
		param: { name: "key", in: "path" },
		description: "SSH key id (`sshk_...`)",
		example: "sshk_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
});

export const CreateSshKeyRequest = z
	.strictObject({
		name: z
			.string()
			.min(1)
			.max(100)
			.regex(NO_CONTROL_CHARS)
			.openapi({ example: "laptop" }),
		publicKey: PublicKeyLine,
	})
	.openapi("CreateSshKeyRequest");

export const SshKeySchema = z
	.object({
		id: z.string().openapi({ example: "sshk_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		name: z.string(),
		fingerprint: z.string().openapi({
			description: "As `ssh-keygen -l`; unique across the platform",
			example: "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
		}),
		type: extensibleEnum(SSH_KEY_TYPES),
		createdAt: Timestamp,
		lastUsedAt: NullableTimestamp,
	})
	.openapi("SshKey");

export const SshKeyListSchema = z
	.object({ data: z.array(SshKeySchema) })
	.openapi("SshKeyList");
