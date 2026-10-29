import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	applySecretPatch,
	emptySecretSets,
	KeyRing,
	SbxError,
	SECRET_FILE_DEFAULT_MODE,
	type SecretSets,
	validateSecretSets,
} from "../src/index.ts";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

const sets: SecretSets = {
	env: { NODE_ENV: "test" },
	secrets: { ANTHROPIC_API_KEY: "sk-1", SBX_API_KEY: "sbx_x" },
	secretFiles: [
		{
			name: "gcp.json",
			contentBase64: Buffer.from("{}").toString("base64"),
			mode: 0o440,
			linkPath: "/home/user/.config/gcloud/key.json",
		},
	],
};

function issuesOf(fn: () => void): { path: string; message: string }[] {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(SbxError);
		expect((e as SbxError).code).toBe("validation");
		return (e as SbxError).details.issues as {
			path: string;
			message: string;
		}[];
	}
	throw new Error("expected a validation error");
}

describe("KeyRing", () => {
	it("roundtrips SecretSets with AAD of the sandbox", () => {
		const ring = KeyRing.fromObject({ current: 2, keys: { "1": k1, "2": k2 } });
		expect(ring.currentVersion).toBe(2);
		const row = ring.encrypt("sb-1", sets);
		expect(row.keyVersion).toBe(2);
		expect(row.nonce.length).toBe(12);
		expect(row.ciphertext.length).toBeGreaterThan(16);
		expect(row.ciphertext.toString("utf8")).not.toContain("sk-1");
		expect(ring.decrypt("sb-1", row)).toEqual(sets);
	});

	it("uses a fresh nonce per encryption", () => {
		const ring = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
		const a = ring.encrypt("sb-1", sets);
		const b = ring.encrypt("sb-1", sets);
		expect(a.nonce.equals(b.nonce)).toBe(false);
		expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
	});

	it("fails to decrypt under another sandbox's AAD", () => {
		const ring = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
		const row = ring.encrypt("sb-1", sets);
		expect(() => ring.decrypt("sb-2", row)).toThrow();
	});

	it("fails on a tampered ciphertext or a relabelled key version", () => {
		const ring = KeyRing.fromObject({ current: 2, keys: { "1": k1, "2": k2 } });
		const row = ring.encrypt("sb-1", sets);
		const bad = Buffer.from(row.ciphertext);
		bad[0] = (bad[0] ?? 0) ^ 1;
		expect(() => ring.decrypt("sb-1", { ...row, ciphertext: bad })).toThrow();
		expect(() => ring.decrypt("sb-1", { ...row, keyVersion: 1 })).toThrow();
		expect(() => ring.decrypt("sb-1", { ...row, keyVersion: 3 })).toThrow(
			/key version 3/,
		);
	});

	it("reads a v1 record after rotation to current=2", () => {
		const old = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
		const row = old.encrypt("sb-1", sets);
		const rotated = KeyRing.fromObject({
			current: 2,
			keys: { "1": k1, "2": k2 },
		});
		expect(row.keyVersion).toBe(1);
		expect(rotated.decrypt("sb-1", row)).toEqual(sets);
		expect(rotated.encrypt("sb-1", sets).keyVersion).toBe(2);
	});

	it("encryptFor/decryptFor bind the AAD prefix", () => {
		const ring = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
		const blob = ring.encryptFor("environment", "env-1", Buffer.from("hello"));
		expect(ring.decryptFor("environment", "env-1", blob).toString()).toBe(
			"hello",
		);
		expect(() => ring.decryptFor("sandbox", "env-1", blob)).toThrow();
		// encrypt() is encryptFor("sandbox", ...)
		const row = ring.encrypt("sb-1", sets);
		expect(
			JSON.parse(ring.decryptFor("sandbox", "sb-1", row).toString()),
		).toEqual(sets);
	});

	it("validates the key ring", () => {
		expect(() =>
			KeyRing.fromObject({ current: 3, keys: { "1": k1 } }),
		).toThrow();
		expect(() =>
			KeyRing.fromObject({
				current: 1,
				keys: { "1": randomBytes(16).toString("base64") },
			}),
		).toThrow(/32 bytes/);
		expect(() =>
			KeyRing.fromObject({ current: 1, keys: { "1": "not base64!" } }),
		).toThrow();
		expect(() => KeyRing.fromObject({ current: 1, keys: { x: k1 } })).toThrow();
		expect(() => KeyRing.fromObject({ current: 1, keys: {} })).toThrow();
		expect(() => KeyRing.fromObject(null as never)).toThrow();
	});

	it("loads from a file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "sbx-keys-"));
		const file = path.join(dir, "keys.json");
		writeFileSync(
			file,
			JSON.stringify({ current: 2, keys: { "1": k1, "2": k2 } }),
		);
		const ring = KeyRing.fromFile(file);
		expect(ring.currentVersion).toBe(2);
		expect(ring.versions).toEqual([1, 2]);
		expect(ring.decrypt("sb", ring.encrypt("sb", sets))).toEqual(sets);
	});
});

describe("applySecretPatch", () => {
	it("null deletes a key, values override, untouched sets stay", () => {
		const out = applySecretPatch(sets, {
			env: { NODE_ENV: null, DEBUG: "1" },
			secrets: { ANTHROPIC_API_KEY: "sk-2" },
		});
		expect(out.env).toEqual({ DEBUG: "1" });
		expect(out.secrets).toEqual({
			ANTHROPIC_API_KEY: "sk-2",
			SBX_API_KEY: "sbx_x",
		});
		expect(out.secretFiles).toEqual(sets.secretFiles);
		// base is not mutated
		expect(sets.env).toEqual({ NODE_ENV: "test" });
	});

	it("replaces secret files by name, deletes with null, appends new", () => {
		const base: SecretSets = {
			...emptySecretSets(),
			secretFiles: [
				{ name: "a", contentBase64: "YQ==" },
				{ name: "b", contentBase64: "Yg==" },
			],
		};
		const out = applySecretPatch(base, {
			secretFiles: {
				a: { contentBase64: "QQ==", mode: 0o400 },
				b: null,
				c: { contentBase64: "Yw==", linkPath: "/tmp/c" },
			},
		});
		expect(out.secretFiles).toEqual([
			{ name: "a", contentBase64: "QQ==", mode: 0o400 },
			{ name: "c", contentBase64: "Yw==", linkPath: "/tmp/c" },
		]);
		expect(base.secretFiles).toHaveLength(2);
	});

	it("an empty patch returns equal sets", () => {
		expect(applySecretPatch(sets, {})).toEqual(sets);
	});
});

describe("validateSecretSets", () => {
	it("accepts valid sets and the allowed SBX_ names", () => {
		expect(() => validateSecretSets(sets)).not.toThrow();
		expect(() =>
			validateSecretSets({
				env: { SBX_API_URL: "u", SBX_TEAM: "t", SBX_PROFILE: "p", _x: "" },
				secrets: { SBX_API_KEY: "k" },
				secretFiles: [],
			}),
		).not.toThrow();
		expect(SECRET_FILE_DEFAULT_MODE).toBe(0o440);
	});

	it("rejects 101 variables", () => {
		const env: Record<string, string> = {};
		for (let i = 0; i < 101; i++) env[`V${i}`] = "x";
		expect(
			issuesOf(() => validateSecretSets({ ...emptySecretSets(), env })),
		).toEqual([{ path: "env", message: expect.stringContaining("100") }]);
	});

	it("rejects reserved SBX_ names", () => {
		expect(
			issuesOf(() =>
				validateSecretSets({ ...emptySecretSets(), secrets: { SBX_FOO: "x" } }),
			),
		).toEqual([
			{ path: "secrets.SBX_FOO", message: expect.stringContaining("SBX_") },
		]);
	});

	it("rejects bad keys and values", () => {
		const issues = issuesOf(() =>
			validateSecretSets({
				...emptySecretSets(),
				env: {
					"1BAD": "x",
					"A-B": "x",
					[`K${"x".repeat(128)}`]: "x",
					NUL: "a\0b",
					BIG: "x".repeat(32 * 1024 + 1),
				},
			}),
		);
		expect(issues.map((i) => i.path).sort()).toEqual(
			[
				"env.1BAD",
				"env.A-B",
				`env.K${"x".repeat(128)}`,
				"env.NUL",
				"env.BIG",
			].sort(),
		);
	});

	it("rejects more than 256 KiB per set", () => {
		const env: Record<string, string> = {};
		for (let i = 0; i < 9; i++) env[`V${i}`] = "x".repeat(32 * 1024);
		expect(
			issuesOf(() => validateSecretSets({ ...emptySecretSets(), env })),
		).toEqual([{ path: "env", message: expect.stringContaining("256 KiB") }]);
	});

	it("rejects a 33rd file", () => {
		const secretFiles = Array.from({ length: 33 }, (_, i) => ({
			name: `f${i}`,
			contentBase64: "YQ==",
		}));
		expect(
			issuesOf(() => validateSecretSets({ ...emptySecretSets(), secretFiles })),
		).toEqual([
			{ path: "secretFiles", message: expect.stringContaining("32") },
		]);
	});

	it("rejects bad secret files", () => {
		const mib = Buffer.alloc(1024 * 1024 + 1).toString("base64");
		const issues = issuesOf(() =>
			validateSecretSets({
				...emptySecretSets(),
				secretFiles: [
					{ name: "ok.txt", contentBase64: "YQ==" },
					{ name: "ok.txt", contentBase64: "YQ==" },
					{ name: "a/b", contentBase64: "YQ==" },
					{ name: "c", contentBase64: "%%%" },
					{ name: "d", contentBase64: mib },
					{ name: "e", contentBase64: "YQ==", mode: 0o1000 },
					{ name: "f", contentBase64: "YQ==", linkPath: "relative/path" },
					{
						name: "g",
						contentBase64: "YQ==",
						linkPath: "C:\\Users\\u\\key.json",
					},
				],
			}),
		);
		expect(issues.map((i) => i.path)).toEqual([
			"secretFiles[1].name",
			"secretFiles[2].name",
			"secretFiles[3].contentBase64",
			"secretFiles[4].contentBase64",
			"secretFiles[5].mode",
			"secretFiles[6].linkPath",
		]);
	});

	it("rejects more than 8 MiB of files in total", () => {
		const big = Buffer.alloc(1024 * 1024).toString("base64");
		const secretFiles = Array.from({ length: 9 }, (_, i) => ({
			name: `f${i}`,
			contentBase64: big,
		}));
		expect(
			issuesOf(() => validateSecretSets({ ...emptySecretSets(), secretFiles })),
		).toEqual([
			{ path: "secretFiles", message: expect.stringContaining("8 MiB") },
		]);
	});
});
