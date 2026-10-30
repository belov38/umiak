import { SCOPES as AUTH_SCOPES } from "@sbx/auth";
import { describe, expect, it } from "vitest";
import { idempotencyPrincipal, type Principal, SCOPES } from "../src/index.ts";

const base: Principal = {
	kind: "oidc",
	userId: "u1",
	teamId: "t1",
	role: "owner",
	isOperator: false,
	scopes: [...SCOPES],
};

describe("idempotencyPrincipal", () => {
	it("prefers the api key id, then the user id", () => {
		expect(idempotencyPrincipal(base)).toBe("u1");
		expect(
			idempotencyPrincipal({
				...base,
				kind: "team_key",
				userId: null,
				role: null,
				apiKeyId: "k1",
			}),
		).toBe("k1");
	});

	it("throws without either", () => {
		expect(() => idempotencyPrincipal({ ...base, userId: null })).toThrow();
	});

	it("lists the S7 §7.3 scopes", () => {
		expect(SCOPES).toContain("sandboxes:write");
		expect(SCOPES).toContain("keys:admin");
		expect(SCOPES).toHaveLength(14);
	});
});

describe("SCOPES", () => {
	it("is the @sbx/auth list", () => {
		expect([...SCOPES]).toEqual([...AUTH_SCOPES]);
		expect(SCOPES).toBe(AUTH_SCOPES);
	});
});
