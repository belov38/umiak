// The run state written by global-setup.ts (test users of this run).
import { readFileSync } from "node:fs";
import type { KcUser } from "./keycloak.ts";

export const STATE_FILE = new URL("./.state/run.json", import.meta.url);

export interface RunState {
	run: string;
	users: Record<"alice" | "bob" | "op" | "dave", KcUser>;
	fillers: string[];
}

let cached: RunState | undefined;

export function runState(): RunState {
	cached ??= JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
	return cached;
}
