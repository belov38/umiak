// Team API keys of the dashboard (S8 §9.8).
import { describe, expect, it } from "vitest";
import {
	type ApiKey,
	creatorNote,
	emptyKeyForm,
	keyExamples,
	maskedKey,
	PRESETS,
	partitionKeys,
	presetOf,
	toCreateKeyRequest,
} from "../src/lib/api-keys.ts";

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
	id: "key_1",
	name: "ci-main",
	prefix: "a1B2c3D4",
	last4: "9xYz",
	kind: "team",
	scopes: [...PRESETS.ci],
	teamId: "team_1",
	sandboxId: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	createdVia: "dashboard",
	createdBy: { id: "usr_1", email: "a@x", active: true, member: true },
	expiresAt: "2027-01-01T00:00:00.000Z",
	lastUsedAt: null,
	revokedAt: null,
	...over,
});

describe("toCreateKeyRequest", () => {
	it("defaults: preset ci, 90 days", () => {
		expect(toCreateKeyRequest({ ...emptyKeyForm(), name: " ci " })).toEqual({
			ok: true,
			body: { name: "ci", preset: "ci", expiresInSeconds: 90 * 86_400 },
		});
	});

	it("at most 365 days, at least one", () => {
		for (const days of ["0", "366", "1.5", "x", ""]) {
			expect(
				toCreateKeyRequest({ ...emptyKeyForm(), name: "k", days }).ok,
			).toBe(false);
		}
		expect(
			toCreateKeyRequest({ ...emptyKeyForm(), name: "k", days: "365" }),
		).toMatchObject({ ok: true, body: { expiresInSeconds: 365 * 86_400 } });
	});

	it("custom scopes in canonical order; none is refused", () => {
		expect(
			toCreateKeyRequest({
				...emptyKeyForm(),
				name: "k",
				preset: "custom",
				scopes: ["files:read", "sandboxes:read", "files:read"],
			}),
		).toMatchObject({
			ok: true,
			body: { scopes: ["sandboxes:read", "files:read"] },
		});
		expect(
			toCreateKeyRequest({ ...emptyKeyForm(), name: "k", preset: "custom" }).ok,
		).toBe(false);
	});

	it("needs a name", () => {
		expect(toCreateKeyRequest(emptyKeyForm()).ok).toBe(false);
	});
});

describe("key list", () => {
	const now = Date.parse("2026-10-31T00:00:00.000Z");

	it("revoked and expired keys go to the bottom section", () => {
		const live = key({ id: "key_live" });
		const revoked = key({
			id: "key_rev",
			revokedAt: "2026-10-30T00:00:00.000Z",
		});
		const expired = key({
			id: "key_exp",
			expiresAt: "2026-10-30T00:00:00.000Z",
		});
		const p = partitionKeys([revoked, live, expired], now);
		expect(p.live.map((k) => k.id)).toEqual(["key_live"]);
		expect(p.inactive.map((k) => k.id)).toEqual(["key_rev", "key_exp"]);
	});

	it("marks keys of creators who left or were deactivated", () => {
		expect(creatorNote(key())).toBeNull();
		expect(
			creatorNote(
				key({
					createdBy: { id: "u", email: "e", active: true, member: false },
				}),
			),
		).toBe("creator left the team");
		expect(
			creatorNote(
				key({
					createdBy: { id: "u", email: "e", active: false, member: false },
				}),
			),
		).toBe("creator deactivated");
		expect(creatorNote(key({ createdBy: null }))).toBeNull();
	});

	it("presetOf, maskedKey, examples", () => {
		expect(presetOf([...PRESETS["read-only"]].reverse())).toBe("read-only");
		expect(presetOf(["sandboxes:read"])).toBeNull();
		expect(maskedKey(key())).toBe("sbx_a1B2c3D4…9xYz");
		const ex = keyExamples("sbx_SECRET");
		expect(ex[0]).toBe("export SBX_API_KEY=sbx_SECRET");
		expect(ex[1]).toContain("sbx login --key-stdin");
	});
});
