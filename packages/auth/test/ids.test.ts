import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodeUlid,
	decodeUuid,
	encodeUlid,
	encodeUuid,
	ID_PREFIXES,
	newPublicUlid,
} from "../src/index.ts";

/** Local UUIDv7 generator: auth must not depend on core. */
function uuidv7(ms: number): string {
	const b = randomBytes(16);
	b.writeUIntBE(ms, 0, 6);
	b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
	b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe("ID_PREFIXES", () => {
	it("matches S7 §5.3", () => {
		expect(ID_PREFIXES).toEqual({
			sandbox: "sb",
			operation: "op",
			command: "cmd",
			snapshot: "snap",
			apiKey: "key",
			sshKey: "sshk",
			environment: "env",
			user: "usr",
			team: "team",
			upload: "upl",
			request: "req",
		});
	});
});

describe("encodeUuid / decodeUuid", () => {
	it("encodes known vectors", () => {
		expect(encodeUuid("sandbox", "00000000-0000-0000-0000-000000000000")).toBe(
			`sb_${"0".repeat(26)}`,
		);
		expect(encodeUuid("sandbox", "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(
			"sb_7zzzzzzzzzzzzzzzzzzzzzzzzz",
		);
		expect(encodeUuid("team", "00000000-0000-0000-0000-000000000001")).toBe(
			`team_${"0".repeat(25)}1`,
		);
	});

	it("round-trips 1000 random UUIDv7", () => {
		for (let i = 0; i < 1000; i++) {
			const id = uuidv7(1_700_000_000_000 + i * 7919);
			const pub = encodeUuid("sandbox", id);
			expect(pub).toMatch(/^sb_[0-9a-hjkmnp-tv-z]{26}$/);
			expect(decodeUuid("sandbox", pub)).toBe(id);
		}
	});

	it("sorts by creation time", () => {
		const a = encodeUuid("operation", uuidv7(1_700_000_000_000));
		const b = encodeUuid("operation", uuidv7(1_700_000_000_001));
		expect(a < b).toBe(true);
	});

	it("accepts upper case input", () => {
		const id = uuidv7(1_700_000_000_000);
		const pub = encodeUuid("sandbox", id);
		expect(decodeUuid("sandbox", pub.toUpperCase())).toBe(id);
		expect(decodeUuid("sandbox", `SB_${pub.slice(3).toUpperCase()}`)).toBe(id);
	});

	it("accepts upper case uuid in encode", () => {
		const id = uuidv7(1_700_000_000_000);
		expect(encodeUuid("sandbox", id.toUpperCase())).toBe(
			encodeUuid("sandbox", id),
		);
	});

	it("rejects malformed ids with null", () => {
		const ok = encodeUuid("sandbox", uuidv7(1_700_000_000_000));
		expect(decodeUuid("sandbox", `${ok}0`)).toBeNull(); // 27 chars
		expect(decodeUuid("sandbox", ok.slice(0, -1))).toBeNull(); // 25 chars
		expect(decodeUuid("sandbox", `sb_8${"z".repeat(25)}`)).toBeNull(); // overflow
		for (const c of ["i", "l", "o", "u"]) {
			expect(decodeUuid("sandbox", `sb_${c}${ok.slice(4)}`)).toBeNull();
			expect(decodeUuid("sandbox", `${ok.slice(0, -1)}${c}`)).toBeNull();
		}
		expect(decodeUuid("sandbox", ok.replace("sb_", "op_"))).toBeNull();
		expect(decodeUuid("sandbox", ok.replace("sb_", "sb-"))).toBeNull();
		expect(decodeUuid("sandbox", ok.slice(3))).toBeNull();
		expect(decodeUuid("sandbox", "")).toBeNull();
		expect(decodeUuid("sandbox", "sb_")).toBeNull();
		expect(decodeUuid("sandbox", `${ok} `)).toBeNull();
	});

	it("rejects non-string input", () => {
		for (const v of [undefined, null, 42, {}, [], true]) {
			expect(decodeUuid("sandbox", v)).toBeNull();
		}
	});

	it("rejects a foreign prefix that merely ends with ours", () => {
		const ok = encodeUuid("sshKey", uuidv7(1_700_000_000_000));
		expect(decodeUuid("sshKey", ok)).not.toBeNull();
		expect(decodeUuid("snapshot", ok)).toBeNull();
	});

	it("compares the prefix ASCII-only (no Unicode case folding)", () => {
		const ok = encodeUuid("apiKey", uuidv7(1_700_000_000_000));
		const body = ok.slice("key_".length);
		// U+212A KELVIN SIGN lower-cases to "k" under Unicode rules.
		expect("Key_".toLowerCase()).toBe("key_");
		expect(decodeUuid("apiKey", `Key_${body}`)).toBeNull();
		expect(decodeUuid("apiKey", `KEY_${body}`)).not.toBeNull();
	});

	it("throws on an invalid uuid in encode", () => {
		expect(() => encodeUuid("sandbox", "not-a-uuid")).toThrow();
	});
});

describe("encodeUlid / decodeUlid", () => {
	const ulid = "01J8ZQ4W7K3M5N6P7Q8R9S0T1V";

	it("is prefix + lower-case ulid", () => {
		expect(encodeUlid("command", ulid)).toBe(`cmd_${ulid.toLowerCase()}`);
	});

	it("decodes to upper case, any input case", () => {
		const pub = encodeUlid("command", ulid);
		expect(decodeUlid("command", pub)).toBe(ulid);
		expect(decodeUlid("command", pub.toUpperCase())).toBe(ulid);
	});

	it("rejects bad input with null", () => {
		const pub = encodeUlid("command", ulid);
		expect(decodeUlid("command", `${pub}0`)).toBeNull();
		expect(decodeUlid("command", pub.slice(0, -1))).toBeNull();
		expect(decodeUlid("command", `cmd_8${"z".repeat(25)}`)).toBeNull();
		expect(decodeUlid("command", `cmd_i${pub.slice(5)}`)).toBeNull();
		expect(decodeUlid("command", pub.replace("cmd_", "upl_"))).toBeNull();
		expect(decodeUlid("command", 5)).toBeNull();
	});

	it("is consistent with the uuid codec (same 128-bit encoding)", () => {
		const pub = encodeUlid("command", ulid);
		const uuid = decodeUuid("command", pub);
		expect(uuid).not.toBeNull();
		expect(encodeUuid("command", uuid as string)).toBe(pub);
	});

	it("newPublicUlid generates decodable, time-sortable ids", () => {
		const a = newPublicUlid("upload");
		expect(a).toMatch(/^upl_[0-9a-hjkmnp-tv-z]{26}$/);
		expect(decodeUlid("upload", a)).toBe(a.slice(4).toUpperCase());
	});
});
