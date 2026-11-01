// The OS keychain through Bun.secrets (macOS Keychain, libsecret, Windows
// Credential Manager): entries `service: "umiak"`, `name: "<profile>@<issuer|apiUrl>"`.
// Windows entries use `persist: "local"`: a rotating refresh token belongs
// to this computer only.

import { CliError } from "../exit-codes.ts";
import type { CredentialStore } from "./store.ts";

export const KEYCHAIN_SERVICE = "umiak";

/** The part of Bun.secrets the store uses. */
export interface SecretsBackend {
	get(o: { service: string; name: string }): Promise<string | null>;
	set(o: {
		service: string;
		name: string;
		value: string;
		persist?: "local" | "enterprise";
	}): Promise<void>;
	delete(o: { service: string; name: string }): Promise<boolean>;
}

/** Bun.secrets when running on Bun, else undefined. */
export function bunSecrets(): SecretsBackend | undefined {
	const bun = (globalThis as { Bun?: { secrets?: SecretsBackend } }).Bun;
	return bun?.secrets;
}

export class KeychainStore implements CredentialStore {
	readonly kind = "keychain" as const;
	readonly #secrets: SecretsBackend | undefined;

	constructor(secrets: SecretsBackend | undefined) {
		this.#secrets = secrets;
	}

	#backend(): SecretsBackend {
		if (this.#secrets === undefined) {
			throw new CliError({
				code: "keychain_unavailable",
				message: "no OS keychain in this runtime; use --credential-store file",
				retryable: false,
			});
		}
		return this.#secrets;
	}

	async get(name: string): Promise<string | null> {
		return this.#backend().get({ service: KEYCHAIN_SERVICE, name });
	}

	async set(name: string, value: string): Promise<void> {
		await this.#backend().set({
			service: KEYCHAIN_SERVICE,
			name,
			value,
			persist: "local",
		});
	}

	async delete(name: string): Promise<void> {
		await this.#backend().delete({ service: KEYCHAIN_SERVICE, name });
	}
}
