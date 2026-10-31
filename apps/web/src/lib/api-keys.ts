// Team API keys of the dashboard (S8 §9.8, S7 §7.2, §7.3) without the DOM:
// presets, the create body, live vs revoked/expired, the usage examples.
import { PRESETS, SCOPES, type Scope } from "@sbx/auth/scopes";
import type { components } from "@sbx/sdk";

export type ApiKey = components["schemas"]["ApiKey"];
export type CreateApiKeyInput = components["schemas"]["CreateApiKeyRequest"];
export type PresetName = keyof typeof PRESETS;

export { PRESETS, SCOPES, type Scope };

export const PRESET_NAMES: readonly PresetName[] = ["read-only", "ci", "full"];

export const KEY_DAYS_DEFAULT = 90;
export const KEY_DAYS_MAX = 365;
const DAY = 86_400;

/** The preset whose scopes are exactly `scopes`, or null. */
export function presetOf(scopes: readonly string[]): PresetName | null {
	const set = new Set(scopes);
	for (const p of PRESET_NAMES) {
		const ps = PRESETS[p];
		if (ps.length === set.size && ps.every((s) => set.has(s))) return p;
	}
	return null;
}

export interface NewKeyForm {
	name: string;
	/** A preset or "custom" (then `scopes`). */
	preset: PresetName | "custom";
	scopes: Scope[];
	/** Lifetime in days as typed. */
	days: string;
}

export function emptyKeyForm(): NewKeyForm {
	return {
		name: "",
		preset: "ci",
		scopes: [],
		days: String(KEY_DAYS_DEFAULT),
	};
}

export type KeyFormResult =
	| { ok: true; body: CreateApiKeyInput }
	| { ok: false; error: string };

export function toCreateKeyRequest(f: NewKeyForm): KeyFormResult {
	const name = f.name.trim();
	if (name === "") return { ok: false, error: "Give the key a name." };
	if (name.length > 64) {
		return { ok: false, error: "The name is at most 64 characters." };
	}
	const days = Number(f.days.trim());
	if (!Number.isInteger(days) || days < 1 || days > KEY_DAYS_MAX) {
		return {
			ok: false,
			error: `The lifetime is 1 to ${KEY_DAYS_MAX} days.`,
		};
	}
	const expiresInSeconds = days * DAY;
	if (f.preset !== "custom") {
		return { ok: true, body: { name, preset: f.preset, expiresInSeconds } };
	}
	if (f.scopes.length === 0) {
		return { ok: false, error: "Pick at least one scope." };
	}
	const chosen = new Set(f.scopes);
	return {
		ok: true,
		body: {
			name,
			// In the order of SCOPES, without duplicates.
			scopes: SCOPES.filter((s) => chosen.has(s)),
			expiresInSeconds,
		},
	};
}

/** Neither revoked nor expired at `now`. */
export function isLive(k: ApiKey, now: number): boolean {
	return k.revokedAt === null && Date.parse(k.expiresAt) > now;
}

/** Live keys first (as listed: newest first), then revoked and expired ones. */
export function partitionKeys(
	keys: readonly ApiKey[],
	now: number,
): { live: ApiKey[]; inactive: ApiKey[] } {
	const live: ApiKey[] = [];
	const inactive: ApiKey[] = [];
	for (const k of keys) (isLive(k, now) ? live : inactive).push(k);
	return { live, inactive };
}

/** `sbx_a1B2c3D4…9xYz` */
export function maskedKey(k: Pick<ApiKey, "prefix" | "last4">): string {
	return `sbx_${k.prefix}…${k.last4}`;
}

/** Why the key needs attention, from `createdBy` (S8 §9.8, §20.1). */
export function creatorNote(k: ApiKey): string | null {
	const c = k.createdBy;
	if (c === null) return null;
	if (!c.active) return "creator deactivated";
	if (!c.member) return "creator left the team";
	return null;
}

/** Shell lines shown with a new secret (S8 §9.8). */
export function keyExamples(secret: string): string[] {
	return [
		`export SBX_API_KEY=${secret}`,
		`printf '%s' "$SBX_API_KEY" | sbx login --key-stdin`,
	];
}
