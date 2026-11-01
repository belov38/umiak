// Internal listener: service tokens of UMIAK_API_SERVICE_TOKENS_FILE (S7 §7.8,
// S2 §5.5).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServiceTokens, ServiceTokens } from "../src/index.ts";
import { createHarness } from "./helpers/harness.ts";

const T1 = "gw-token-one-0123456789abcdef";
const T2 = "gw-token-two-fedcba9876543210";

function tokensFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "umiak-tokens-"));
	const file = join(dir, "service-tokens.json");
	writeFileSync(file, content);
	return file;
}

function harness() {
	const h = createHarness({
		listener: "internal",
		deps: { serviceTokens: new ServiceTokens({ gateway: [T1, T2] }) },
	});
	h.app.get("/internal/v1/__test", (c) =>
		c.body(null, 204, { "x-caller": c.var.serviceCaller ?? "" }),
	);
	return h;
}

describe("internal listener service tokens", () => {
	it("no token: 401 with a top-level code", async () => {
		const r = await harness().request("GET", "/internal/v1/__test");
		expect(r.status).toBe(401);
		expect(r.body).toMatchObject({
			code: "unauthorized",
			error: { code: "unauthorized" },
		});
	});

	it("an unknown token: 401", async () => {
		const r = await harness().request("GET", "/internal/v1/__test", {
			headers: { authorization: "Bearer nope" },
		});
		expect(r.status).toBe(401);
	});

	it("both tokens of the caller are accepted (rotation)", async () => {
		const h = harness();
		for (const t of [T1, T2]) {
			const r = await h.request("GET", "/internal/v1/__test", {
				headers: { authorization: `Bearer ${t}` },
			});
			expect(r.status).toBe(204);
			expect(r.headers.get("x-caller")).toBe("gateway");
		}
	});

	it("unknown paths need a token too: 401 without, 404 with", async () => {
		const h = harness();
		expect((await h.request("GET", "/internal/v1/nope")).status).toBe(401);
		const r = await h.request("GET", "/internal/v1/nope", {
			headers: { authorization: `Bearer ${T1}` },
		});
		expect(r.status).toBe(404);
	});

	it("a team key or the token of another scheme is not a service token", async () => {
		const r = await harness().request("GET", "/internal/v1/__test", {
			headers: { authorization: `Basic ${T1}` },
		});
		expect(r.status).toBe(401);
	});
});

describe("loadServiceTokens", () => {
	it("reads {caller: [tokens]}", () => {
		const t = loadServiceTokens(
			tokensFile(JSON.stringify({ gateway: [T1, T2] })),
		);
		expect(t.verify(T2)).toBe("gateway");
		expect(t.verify("x")).toBeNull();
	});

	it("rejects a malformed file", () => {
		expect(() => loadServiceTokens(tokensFile("not json"))).toThrow();
		expect(() =>
			loadServiceTokens(tokensFile(JSON.stringify({ gateway: "t" }))),
		).toThrow();
		expect(() =>
			loadServiceTokens(tokensFile(JSON.stringify({ gateway: [""] }))),
		).toThrow();
	});

	it("errors never echo the file's content (a bare token is a secret)", () => {
		const secret = "s3cr3t-0123456789abcdef";
		for (const content of [
			secret,
			`{"gateway": [${secret}]}`,
			JSON.stringify({ gateway: secret }),
			JSON.stringify([secret]),
		]) {
			let message = "";
			try {
				loadServiceTokens(tokensFile(content));
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message, content).not.toBe("");
			expect(message, content).not.toContain("s3cr");
		}
	});

	it("an empty token never matches", () => {
		const t = new ServiceTokens({ gateway: [T1] });
		expect(t.verify("")).toBeNull();
	});
});
