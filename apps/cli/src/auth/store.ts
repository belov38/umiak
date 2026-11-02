// Credential storage (S7 §7.6): the OS keychain through Bun.secrets, or the
// file credentials.json (0600) when there is no keychain (Linux without a
// secret service, containers). `--credential-store keychain|file|auto` (or
// UMIAK_CREDENTIAL_STORE) picks one; `auto` tries the keychain and falls back
// to the file on an error. config.json holds no secrets.

import { CliError } from "../exit-codes.ts";
import { FileStore } from "./file-store.ts";
import { KeychainStore, type SecretsBackend } from "./keychain.ts";

export type StoreChoice = "keychain" | "file" | "auto";

export interface CredentialStore {
	/** "keychain" or "file"; for `auto`, the store of the last successful write. */
	readonly kind: "keychain" | "file";
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
}

export interface StoreOptions {
	/** Path of credentials.json. */
	file: string;
	/** Bun.secrets, or a stand-in; undefined: no keychain in this runtime. */
	secrets: SecretsBackend | undefined;
	/** Warnings go to stderr. */
	warn(message: string): void;
}

export function parseStoreChoice(v: string): StoreChoice {
	if (v === "keychain" || v === "file" || v === "auto") return v;
	throw new CliError({
		code: "usage",
		message: `--credential-store must be keychain, file or auto, not ${JSON.stringify(v)}`,
		retryable: false,
		exitCode: 2,
	});
}

export function openCredentialStore(
	choice: StoreChoice,
	o: StoreOptions,
): CredentialStore {
	const file = () => new FileStore(o.file);
	if (choice === "file") return file();
	const keychain = new KeychainStore(o.secrets);
	if (choice === "keychain") return keychain;
	return new AutoStore(keychain, file(), o.warn);
}

/** The keychain first; the file when the keychain fails. */
export class AutoStore implements CredentialStore {
	kind: "keychain" | "file" = "keychain";
	readonly #keychain: CredentialStore;
	readonly #file: CredentialStore;
	readonly #warn: (m: string) => void;
	#warned = false;

	constructor(
		keychain: CredentialStore,
		file: CredentialStore,
		warn: (m: string) => void,
	) {
		this.#keychain = keychain;
		this.#file = file;
		this.#warn = warn;
	}

	async get(name: string): Promise<string | null> {
		try {
			const v = await this.#keychain.get(name);
			if (v !== null) return v;
		} catch {
			// No keychain here: the file is the only store.
		}
		return this.#file.get(name);
	}

	async set(name: string, value: string): Promise<void> {
		try {
			await this.#keychain.set(name, value);
			this.kind = "keychain";
			// A stale copy in the file would shadow nothing but is a leak.
			await this.#file.delete(name);
			return;
		} catch (err) {
			if (!this.#warned) {
				this.#warned = true;
				this.#warn(
					`OS keychain unavailable (${err instanceof Error ? err.message : String(err)}); using the credentials file`,
				);
			}
		}
		await this.#file.set(name, value);
		this.kind = "file";
	}

	async delete(name: string): Promise<void> {
		try {
			await this.#keychain.delete(name);
		} catch {
			// Nothing to delete where there is no keychain.
		}
		await this.#file.delete(name);
	}
}
