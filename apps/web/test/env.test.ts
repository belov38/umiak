import { describe, expect, it } from "vitest";
import { parseWebEnv, WebEnvError } from "../src/lib/env.ts";
import { switchTeamPath } from "../src/lib/team-path.ts";

const OK = {
	UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
	DATABASE_URL: "postgres://web:pw@postgres:5432/umiak",
	PAYLOAD_SECRET: "0123456789abcdef0123",
	UMIAK_APP_ORIGIN: "https://app.umiak.example.com",
	UMIAK_OPERATOR_GROUPS: " umiak-operators, admins ,,umiak-operators",
	UMIAK_PREVIEW_DOMAIN: "UMIAK.example.com",
	UMIAK_API_PUBLIC_URL: "https://api.umiak.example.com/",
};

describe("parseWebEnv (S8 §14.1)", () => {
	it("parses and normalizes", () => {
		expect(parseWebEnv(OK)).toEqual({
			authMode: "owner",
			localAllowedCidrs: "127.0.0.0/8",
			localDeniedCidrs: "10.88.0.0/24",
			databaseUrl: OK.DATABASE_URL,
			payloadSecret: OK.PAYLOAD_SECRET,
			appOrigin: "https://app.umiak.example.com",
			operatorGroups: ["umiak-operators", "admins"],
			umiakDomain: "umiak.example.com",
			previewScheme: "https",
			previewPort: 443,
			apiPublicUrl: "https://api.umiak.example.com",
		});
	});

	it("reports every problem at once", () => {
		let err: unknown;
		try {
			parseWebEnv({
				UMIAK_APP_ORIGIN: "https://app.example.com/",
				UMIAK_PREVIEW_DOMAIN: "*.bad",
				PAYLOAD_SECRET: "short",
				UMIAK_LOGOUT_URL: "",
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebEnvError);
		const issues = (err as WebEnvError).issues.join("\n");
		for (const k of [
			"DATABASE_URL",
			"PAYLOAD_SECRET",
			"UMIAK_APP_ORIGIN",
			"UMIAK_OPERATOR_GROUPS",
			"UMIAK_PREVIEW_DOMAIN",
			"UMIAK_API_PUBLIC_URL",
		]) {
			expect(issues).toContain(k);
		}
		// An empty optional value is absent, not invalid.
		expect(issues).not.toContain("UMIAK_LOGOUT_URL");
	});

	it("validates preview scheme and port before constructing frame origins", () => {
		expect(
			parseWebEnv({
				...OK,
				UMIAK_PREVIEW_SCHEME: "http",
				UMIAK_PREVIEW_PORT: "8085",
			}),
		).toMatchObject({ previewScheme: "http", previewPort: 8085 });
		expect(parseWebEnv({ ...OK, UMIAK_PREVIEW_SCHEME: "http" })).toMatchObject({
			previewScheme: "http",
			previewPort: 80,
		});
		expect(() =>
			parseWebEnv({ ...OK, UMIAK_PREVIEW_SCHEME: "javascript" }),
		).toThrow("UMIAK_PREVIEW_SCHEME");
		expect(() => parseWebEnv({ ...OK, UMIAK_PREVIEW_PORT: "65536" })).toThrow(
			"UMIAK_PREVIEW_PORT",
		);
	});
});

describe("team paths (S8 §9.2)", () => {
	it("switching team keeps the section, drops team-bound pages", () => {
		expect(switchTeamPath("/app/t/team_a", "team_b")).toBe("/app/t/team_b");
		expect(switchTeamPath("/app/t/team_a/keys", "team_b")).toBe(
			"/app/t/team_b/keys",
		);
		expect(switchTeamPath("/app/t/team_a/sandboxes/web-1", "team_b")).toBe(
			"/app/t/team_b",
		);
		expect(switchTeamPath("/app/account", "team_b")).toBe("/app/t/team_b");
	});
});
