// The environment form → bodies of POST and PATCH /v1/environments
// (S8 §10.1, §10.2): repository checks, merge patches, write-only secrets.
import { describe, expect, it } from "vitest";
import {
	type EnvironmentDetail,
	type EnvironmentFormState,
	emptyEnvironmentForm,
	environmentNameProblem,
	formFromEnvironment,
	MAX_REPOSITORIES,
	repositoryUrlProblem,
	toCreateEnvironmentRequest,
	toEnvironmentPatch,
} from "../src/lib/environment-form.ts";

const form = (
	over: Partial<EnvironmentFormState> = {},
): EnvironmentFormState => ({
	...emptyEnvironmentForm(),
	name: "prod",
	...over,
});

const created = (f: EnvironmentFormState) => {
	const r = toCreateEnvironmentRequest(f);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.body;
};

const errorsOf = (f: EnvironmentFormState) => {
	const r = toCreateEnvironmentRequest(f);
	if (r.ok) throw new Error("expected errors");
	return r.errors;
};

const original: EnvironmentDetail = {
	id: "env_1",
	name: "prod",
	isDefault: false,
	revision: 3,
	env: { A: "1", B: "2" },
	envKeys: ["A", "B"],
	secretKeys: ["TOKEN", "OLD"],
	secretFiles: [
		{ name: "gcp.json", mode: 288, linkPath: null, sizeBytes: 10 },
		{ name: "key.pem", mode: 256, linkPath: "/home/user/.k", sizeBytes: 5 },
	],
	repositories: [{ url: "https://github.com/acme/web.git", branch: "main" }],
	excludeOwnerSecrets: false,
	createdAt: "2026-10-30T10:00:00.000Z",
	updatedAt: "2026-10-31T10:00:00.000Z",
	updatedBy: "usr_1",
};

const patched = (f: EnvironmentFormState) => {
	const r = toEnvironmentPatch(original, f);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.body;
};

describe("environmentNameProblem", () => {
	it("follows ^[a-z0-9][a-z0-9-]{0,62}$ and refuses a UUID form", () => {
		expect(environmentNameProblem("prod-1")).toBeNull();
		expect(environmentNameProblem("")).not.toBeNull();
		expect(environmentNameProblem("-x")).not.toBeNull();
		expect(environmentNameProblem("Prod")).not.toBeNull();
		expect(environmentNameProblem("a".repeat(64))).not.toBeNull();
		expect(
			environmentNameProblem("0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f70"),
		).not.toBeNull();
	});
});

describe("repositoryUrlProblem", () => {
	it("accepts https, ssh and scp-like URLs", () => {
		for (const u of [
			"https://github.com/acme/web.git",
			"ssh://git@github.com/acme/web.git",
			"git@github.com:acme/web.git",
		]) {
			expect(repositoryUrlProblem(u), u).toBeNull();
		}
	});

	it("refuses credentials, tokens in the query, fragments and other schemes", () => {
		for (const u of [
			"https://user:pass@github.com/acme/web.git",
			"https://token@github.com/acme/web.git",
			"ssh://git:secret@github.com/acme/web.git",
			"https://github.com/acme/web.git?token=x",
			"https://github.com/acme/web.git#main",
			"http://github.com/acme/web.git",
			"file:///etc/passwd",
			"github.com/acme/web",
			"",
		]) {
			expect(repositoryUrlProblem(u), u).not.toBeNull();
		}
	});
});

describe("toCreateEnvironmentRequest", () => {
	it("sends the name and nothing else for an empty form", () => {
		expect(created(form())).toEqual({ name: "prod" });
	});

	it("sends flags, sets, files and repositories; blank rows dropped", () => {
		const body = created(
			form({
				isDefault: true,
				excludeOwnerSecrets: true,
				env: [
					{ key: " NODE_ENV ", value: "production" },
					{ key: "", value: "" },
				],
				secrets: [{ key: "TOKEN", value: "s3cret" }],
				secretFiles: [
					{
						name: "gcp.json",
						mode: "0400",
						linkPath: "/home/user/gcp.json",
						contentBase64: "eA==",
						sizeBytes: 1,
					},
				],
				repositories: [
					{ url: " https://github.com/acme/web.git ", branch: "", path: "" },
					{ url: "", branch: "", path: "" },
					{
						url: "git@github.com:acme/api.git",
						branch: "dev",
						path: "src/api",
					},
				],
			}),
		);
		expect(body).toEqual({
			name: "prod",
			isDefault: true,
			excludeOwnerSecrets: true,
			env: { NODE_ENV: "production" },
			secrets: { TOKEN: "s3cret" },
			secretFiles: [
				{
					name: "gcp.json",
					contentBase64: "eA==",
					mode: 0o400,
					linkPath: "/home/user/gcp.json",
				},
			],
			repositories: [
				{ url: "https://github.com/acme/web.git" },
				{ url: "git@github.com:acme/api.git", branch: "dev", path: "src/api" },
			],
		});
	});

	it("reports problems per field", () => {
		const errors = errorsOf(
			form({
				name: "Bad Name",
				env: [{ key: "1X", value: "v" }],
				secrets: [{ key: "UMIAK_FOO", value: "v" }],
				repositories: [
					{ url: "https://u:p@github.com/a/b.git", branch: "", path: "" },
					{ url: "https://github.com/a/c.git", branch: "a b", path: "/abs" },
					{ url: "https://github.com/a/d.git", branch: "", path: "x/../y" },
					{ url: "", branch: "main", path: "" },
				],
			}),
		);
		expect(Object.keys(errors).sort()).toEqual(
			[
				"name",
				"env.0",
				"secrets.0",
				"repositories.0.url",
				"repositories.1.branch",
				"repositories.1.path",
				"repositories.2.path",
				"repositories.3.url",
			].sort(),
		);
	});

	it("at most 20 repositories", () => {
		const repo = { url: "https://github.com/a/b.git", branch: "", path: "" };
		expect(
			errorsOf(form({ repositories: Array(MAX_REPOSITORIES + 1).fill(repo) }))
				.repositories,
		).toBeDefined();
		expect(
			toCreateEnvironmentRequest(
				form({ repositories: Array(MAX_REPOSITORIES).fill(repo) }),
			).ok,
		).toBe(true);
	});
});

describe("formFromEnvironment", () => {
	it("fills env values and repositories; secrets stay empty (write-only)", () => {
		const f = formFromEnvironment(original);
		expect(f.name).toBe("prod");
		expect(f.env).toEqual([
			{ key: "A", value: "1" },
			{ key: "B", value: "2" },
		]);
		expect(f.secrets).toEqual([{ key: "", value: "" }]);
		expect(f.removedSecrets).toEqual([]);
		expect(f.secretFiles).toEqual([]);
		expect(f.removedSecretFiles).toEqual([]);
		expect(f.repositories).toEqual([
			{ url: "https://github.com/acme/web.git", branch: "main", path: "" },
		]);
	});
});

describe("toEnvironmentPatch", () => {
	it("an unchanged form is an empty patch", () => {
		const r = toEnvironmentPatch(original, formFromEnvironment(original));
		expect(r).toEqual({ ok: true, body: {}, empty: true });
	});

	it("env: changed and new keys with values, removed keys as null", () => {
		const f = formFromEnvironment(original);
		f.env = [
			{ key: "A", value: "1" },
			{ key: "C", value: "3" },
		];
		expect(patched(f)).toEqual({ env: { B: null, C: "3" } });
		f.env = [{ key: "A", value: "one" }];
		expect(patched(f)).toEqual({ env: { A: "one", B: null } });
	});

	it("secrets: values only for what is typed, null for what is removed", () => {
		const f = formFromEnvironment(original);
		f.secrets = [
			{ key: "TOKEN", value: "new" },
			{ key: "NEW", value: "x" },
		];
		f.removedSecrets = ["OLD"];
		expect(patched(f)).toEqual({
			secrets: { TOKEN: "new", NEW: "x", OLD: null },
		});
	});

	it("a typed secret wins over removing the same name; unknown removals are ignored", () => {
		const f = formFromEnvironment(original);
		f.secrets = [{ key: "OLD", value: "again" }];
		f.removedSecrets = ["OLD", "NOT_THERE"];
		expect(patched(f)).toEqual({ secrets: { OLD: "again" } });
	});

	it("secret files: new files by name, removed ones null", () => {
		const f = formFromEnvironment(original);
		f.secretFiles = [
			{
				name: "gcp.json",
				mode: "",
				linkPath: "",
				contentBase64: "eQ==",
				sizeBytes: 1,
			},
		];
		f.removedSecretFiles = ["key.pem"];
		expect(patched(f)).toEqual({
			secretFiles: {
				"gcp.json": { contentBase64: "eQ==" },
				"key.pem": null,
			},
		});
	});

	it("repositories: the whole list when it changed, nothing otherwise", () => {
		const f = formFromEnvironment(original);
		f.repositories = [
			{ url: "https://github.com/acme/web.git", branch: " main ", path: "" },
		];
		expect(patched(f)).toEqual({});
		f.repositories = [{ url: "", branch: "", path: "" }];
		expect(patched(f)).toEqual({ repositories: [] });
		f.repositories = [
			{ url: "https://github.com/acme/web.git", branch: "main", path: "" },
			{ url: "git@github.com:acme/api.git", branch: "", path: "" },
		];
		expect(patched(f)).toEqual({
			repositories: [
				{ url: "https://github.com/acme/web.git", branch: "main" },
				{ url: "git@github.com:acme/api.git" },
			],
		});
	});

	it("name and flags only when changed", () => {
		const f = formFromEnvironment(original);
		f.name = "production";
		f.isDefault = true;
		f.excludeOwnerSecrets = true;
		expect(patched(f)).toEqual({
			name: "production",
			isDefault: true,
			excludeOwnerSecrets: true,
		});
	});

	it("validation problems are reported like on create", () => {
		const f = formFromEnvironment(original);
		f.repositories = [
			{ url: "https://x:y@github.com/a/b.git", branch: "", path: "" },
		];
		f.secrets = [{ key: "bad key", value: "v" }];
		const r = toEnvironmentPatch(original, f);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(Object.keys(r.errors).sort()).toEqual([
				"repositories.0.url",
				"secrets.0",
			]);
		}
	});

	it("a secret row with a name but an empty value is an error, not a deletion", () => {
		const f = formFromEnvironment(original);
		f.secrets = [{ key: "TOKEN", value: "" }];
		const r = toEnvironmentPatch(original, f);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors["secrets.0"]).toBeDefined();
	});
});
