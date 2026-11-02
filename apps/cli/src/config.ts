// Files of `umiak` (S7 §14.1, §7.6):
// - config dir: $XDG_CONFIG_HOME/umiak (default ~/.config/umiak; Windows
//   %APPDATA%\umiak) with config.json (0600, no secrets), credentials.json
//   (the file credential store, 0600) and .lock (the refresh lock);
// - state dir: $XDG_STATE_HOME/umiak (default ~/.local/state/umiak; Windows
//   %LOCALAPPDATA%\umiak) with current/<shell key>;
// - system config /etc/umiak/config.json (only `apiUrl`; the VM template puts
//   it there). UMIAK_SYSTEM_CONFIG replaces the path (tests).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./exit-codes.ts";

export type Env = Record<string, string | undefined>;

export type AuthKind = "oidc" | "key";
export type StoreKind = "keychain" | "file";

export interface Profile {
	apiUrl: string;
	/** Team chosen at login (`--team` / UMIAK_TEAM); else the default team of the user. */
	team?: string;
	auth: AuthKind;
	/** Keycloak issuer of an `oidc` profile. */
	issuer?: string;
	/** Where `umiak login` stored the credentials. */
	credentialStore?: StoreKind;
}

export interface Config {
	current?: string;
	profiles: Record<string, Profile>;
}

export interface Paths {
	configDir: string;
	stateDir: string;
	config: string;
	credentials: string;
	lock: string;
	systemConfig: string;
}

export const DEFAULT_PROFILE = "default";

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

export function pathsOf(env: Env): Paths {
	const win = process.platform === "win32";
	const home = nonEmpty(env.HOME) ?? homedir();
	const configBase =
		nonEmpty(env.XDG_CONFIG_HOME) ??
		(win ? nonEmpty(env.APPDATA) : undefined) ??
		join(home, ".config");
	const stateBase =
		nonEmpty(env.XDG_STATE_HOME) ??
		(win ? nonEmpty(env.LOCALAPPDATA) : undefined) ??
		join(home, ".local", "state");
	const configDir = join(configBase, "umiak");
	return {
		configDir,
		stateDir: join(stateBase, "umiak"),
		config: join(configDir, "config.json"),
		credentials: join(configDir, "credentials.json"),
		lock: join(configDir, ".lock"),
		systemConfig:
			nonEmpty(env.UMIAK_SYSTEM_CONFIG) ??
			(win
				? join(
						nonEmpty(env.ProgramData) ?? "C:\\ProgramData",
						"umiak",
						"config.json",
					)
				: "/etc/umiak/config.json"),
	};
}

/** Parsed JSON of a file, or undefined when the file does not exist. */
export function readJsonFile(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new CliError({
			code: "invalid_config",
			message: `${path} is not valid JSON; fix or remove it`,
			retryable: false,
		});
	}
}

/** Writes a file with mode 0600 through a temporary file and a rename. */
export function writePrivateFile(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readConfig(paths: Paths): Config {
	const v = readJsonFile(paths.config);
	if (v === undefined) return { profiles: {} };
	if (!isRecord(v)) {
		throw new CliError({
			code: "invalid_config",
			message: `${paths.config} must be a JSON object`,
			retryable: false,
		});
	}
	const profiles: Record<string, Profile> = {};
	if (isRecord(v.profiles)) {
		for (const [name, p] of Object.entries(v.profiles)) {
			if (isRecord(p) && typeof p.apiUrl === "string") {
				profiles[name] = p as unknown as Profile;
			}
		}
	}
	return typeof v.current === "string"
		? { current: v.current, profiles }
		: { profiles };
}

export function writeConfig(paths: Paths, c: Config): void {
	writePrivateFile(paths.config, `${JSON.stringify(c, null, 2)}\n`);
}

/** `apiUrl` of the system config, if any. */
export function systemApiUrl(paths: Paths): string | undefined {
	let v: unknown;
	try {
		v = readJsonFile(paths.systemConfig);
	} catch {
		return undefined;
	}
	return isRecord(v) && typeof v.apiUrl === "string" && v.apiUrl !== ""
		? v.apiUrl
		: undefined;
}
