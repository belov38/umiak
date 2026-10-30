// The file credential store: credentials.json in the config dir, mode 0600,
// `{"<profile>@<issuer|apiUrl>": "<value>"}`. `sbx login` warns on stderr
// when it stores secrets here. Writes happen under the config lock
// (lock.ts), so read-modify-write needs no lock of its own.

import { chmodSync, statSync } from "node:fs";
import { readJsonFile, writePrivateFile } from "../config.ts";
import type { CredentialStore } from "./store.ts";

export class FileStore implements CredentialStore {
	readonly kind = "file" as const;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	#read(): Record<string, string> {
		const v = readJsonFile(this.path);
		if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
		const out: Record<string, string> = {};
		for (const [k, x] of Object.entries(v)) {
			if (typeof x === "string") out[k] = x;
		}
		return out;
	}

	#write(all: Record<string, string>): void {
		writePrivateFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
	}

	async get(name: string): Promise<string | null> {
		this.#tightenMode();
		return this.#read()[name] ?? null;
	}

	async set(name: string, value: string): Promise<void> {
		const all = this.#read();
		all[name] = value;
		this.#write(all);
	}

	async delete(name: string): Promise<void> {
		const all = this.#read();
		if (!(name in all)) return;
		delete all[name];
		this.#write(all);
	}

	/** A file someone made readable by others goes back to 0600. */
	#tightenMode(): void {
		if (process.platform === "win32") return;
		try {
			if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
		} catch {
			// No file yet.
		}
	}
}
