// The create form → the body of POST /v1/sandboxes (S8 §9.5, §10.1).
import { describe, expect, it } from "vitest";
import {
	bytesToBase64,
	type CreateFormState,
	emptyCreateForm,
	newSandboxHref,
	parsePrefill,
	parseSecretFileMode,
	slugProblem,
	toCreateRequest,
} from "../src/lib/create-form.ts";

const form = (over: Partial<CreateFormState> = {}): CreateFormState => ({
	...emptyCreateForm(),
	template: "linux",
	size: "2gb",
	...over,
});

const ok = (f: CreateFormState) => {
	const r = toCreateRequest(f);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.body;
};

describe("toCreateRequest", () => {
	it("sends only what was chosen", () => {
		expect(ok(form())).toEqual({ template: "linux", size: "2gb" });
	});

	it("drops empty rows of labels, env and secrets, trims keys", () => {
		const body = ok(
			form({
				labels: [
					{ key: " session ", value: "42" },
					{ key: "", value: "" },
					{ key: "  ", value: "" },
				],
				env: [
					{ key: "", value: "" },
					{ key: "NODE_ENV", value: "test" },
				],
				secrets: [{ key: "", value: "" }],
			}),
		);
		expect(body.labels).toEqual({ session: "42" });
		expect(body.env).toEqual({ NODE_ENV: "test" });
		expect(body).not.toHaveProperty("secrets");
	});

	it("keeps an env value with spaces as typed and allows an empty value", () => {
		const body = ok(
			form({
				env: [
					{ key: "A", value: "  x  " },
					{ key: "EMPTY", value: "" },
				],
			}),
		);
		expect(body.env).toEqual({ A: "  x  ", EMPTY: "" });
	});

	it("refuses a value without a key, bad keys, SBX_ and duplicates", () => {
		const r = toCreateRequest(
			form({
				env: [
					{ key: "", value: "orphan" },
					{ key: "1BAD", value: "x" },
					{ key: "SBX_FOO", value: "x" },
					{ key: "A", value: "1" },
					{ key: "A", value: "2" },
				],
			}),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(Object.keys(r.errors).sort()).toEqual([
			"env.0",
			"env.1",
			"env.2",
			"env.4",
		]);
	});

	it("allows the CLI variables of SBX_ as secrets", () => {
		const body = ok(
			form({ secrets: [{ key: "SBX_API_KEY", value: "sbx_x" }] }),
		);
		expect(body.secrets).toEqual({ SBX_API_KEY: "sbx_x" });
	});

	it("environment: omitted for the team default, null for none, the name otherwise", () => {
		expect(ok(form({ environment: { kind: "default" } }))).not.toHaveProperty(
			"environment",
		);
		expect(ok(form({ environment: { kind: "none" } })).environment).toBeNull();
		expect(
			ok(form({ environment: { kind: "named", name: "base" } })).environment,
		).toBe("base");
	});

	it("from a snapshot: `from`, no template", () => {
		const body = ok(form({ source: "snapshot", snapshot: "web-stack" }));
		expect(body.from).toEqual({ snapshot: "web-stack" });
		expect(body).not.toHaveProperty("template");
		const r = toCreateRequest(form({ source: "snapshot", snapshot: "" }));
		expect(r.ok).toBe(false);
	});

	it("name, slug, TTL and idle", () => {
		expect(
			ok(
				form({
					name: " ci-run-42 ",
					slug: "my-box",
					ttl: "3600",
					idle: "none",
				}),
			),
		).toMatchObject({
			name: "ci-run-42",
			slug: "my-box",
			ttlSeconds: 3600,
			idleTimeoutSeconds: null,
		});
		const d = ok(form({ ttl: "default", idle: "default", name: "  " }));
		expect(d).not.toHaveProperty("ttlSeconds");
		expect(d).not.toHaveProperty("idleTimeoutSeconds");
		expect(d).not.toHaveProperty("name");
		expect(ok(form({ ttl: "none" })).ttlSeconds).toBeNull();
	});

	it("checks the slug", () => {
		expect(toCreateRequest(form({ slug: "Bad Slug" })).ok).toBe(false);
		expect(slugProblem("ab")).not.toBeNull();
		expect(slugProblem("box-12")).not.toBeNull();
		expect(slugProblem("quiet-otter-lamp")).toBeNull();
	});

	it("secret files: base64 content, octal mode, link path", () => {
		const body = ok(
			form({
				secretFiles: [
					{
						name: "gcp.json",
						mode: "0440",
						linkPath: "/home/user/.config/gcloud/key.json",
						contentBase64: "e30=",
						sizeBytes: 2,
					},
					{
						name: "plain",
						mode: "",
						linkPath: "",
						contentBase64: "eA==",
						sizeBytes: 1,
					},
				],
			}),
		);
		expect(body.secretFiles).toEqual([
			{
				name: "gcp.json",
				contentBase64: "e30=",
				mode: 0o440,
				linkPath: "/home/user/.config/gcloud/key.json",
			},
			{ name: "plain", contentBase64: "eA==" },
		]);
		const bad = toCreateRequest(
			form({
				secretFiles: [
					{
						name: "a b",
						mode: "999",
						linkPath: "relative/path",
						contentBase64: "",
						sizeBytes: 0,
					},
				],
			}),
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(Object.keys(bad.errors).sort()).toEqual([
				"secretFiles.0.linkPath",
				"secretFiles.0.mode",
				"secretFiles.0.name",
			]);
		}
	});

	it("refuses a secret file over 1 MiB", () => {
		const r = toCreateRequest(
			form({
				secretFiles: [
					{
						name: "big",
						mode: "",
						linkPath: "",
						contentBase64: "x",
						sizeBytes: 1024 * 1024 + 1,
					},
				],
			}),
		);
		expect(r.ok).toBe(false);
	});
});

describe("search params of the create page", () => {
	it("never carry secrets, env, labels or file contents", () => {
		const f = form({
			source: "snapshot",
			snapshot: "web-stack",
			secrets: [{ key: "TOKEN", value: "s3cr3t-value" }],
			env: [{ key: "PUBLIC", value: "env-value" }],
			labels: [{ key: "k", value: "label-value" }],
			secretFiles: [
				{
					name: "f",
					mode: "",
					linkPath: "",
					contentBase64: "ZmlsZS1jb250ZW50",
					sizeBytes: 12,
				},
			],
		});
		// Whatever the caller passes, only the catalog choice goes to the URL.
		const href = newSandboxHref("team_x", f as never);
		const url = new URL(href, "https://app.example.com");
		expect(url.pathname).toBe("/app/t/team_x/sandboxes/new");
		expect([...url.searchParams.keys()].sort()).toEqual([
			"size",
			"snapshot",
			"template",
		]);
		for (const s of [
			"s3cr3t",
			"TOKEN",
			"env-value",
			"label-value",
			"ZmlsZS1jb250ZW50",
		]) {
			expect(href).not.toContain(s);
		}
	});

	it("an empty prefill gives the bare page", () => {
		expect(newSandboxHref("team_x", {})).toBe("/app/t/team_x/sandboxes/new");
		expect(newSandboxHref("team_x", { snapshot: "web-stack" })).toBe(
			"/app/t/team_x/sandboxes/new?snapshot=web-stack",
		);
	});

	it("parsePrefill reads only template, size and snapshot", () => {
		expect(
			parsePrefill({
				snapshot: "web-stack",
				template: ["linux", "windows"],
				secrets: "x",
				TOKEN: "y",
			}),
		).toEqual({ snapshot: "web-stack", template: "linux" });
	});
});

describe("helpers", () => {
	it("bytesToBase64", () => {
		expect(bytesToBase64(new TextEncoder().encode("{}"))).toBe("e30=");
		const big = new Uint8Array(100_000).fill(65);
		expect(bytesToBase64(big)).toBe(Buffer.from(big).toString("base64"));
	});

	it("parseSecretFileMode", () => {
		expect(parseSecretFileMode("")).toBeUndefined();
		expect(parseSecretFileMode("0440")).toBe(0o440);
		expect(parseSecretFileMode("600")).toBe(0o600);
		expect(parseSecretFileMode("0999")).toBeNull();
		expect(parseSecretFileMode("abc")).toBeNull();
	});
});
