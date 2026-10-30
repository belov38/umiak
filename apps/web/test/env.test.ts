import { describe, expect, it } from "vitest";
import { parseWebEnv, WebEnvError } from "../src/lib/env.ts";
import { signOutHref, switchTeamPath } from "../src/lib/team-path.ts";

const OK = {
	DATABASE_URL: "postgres://web:pw@postgres:5432/sbx",
	PAYLOAD_SECRET: "0123456789abcdef0123",
	SBX_APP_ORIGIN: "https://app.sbx.example.com",
	SBX_OPERATOR_GROUPS: " sbx-operators, admins ,,sbx-operators",
	SBX_SBX_DOMAIN: "SBX.example.com",
	SBX_API_PUBLIC_URL: "https://api.sbx.example.com/",
};

describe("parseWebEnv (S8 §14.1)", () => {
	it("parses and normalizes", () => {
		expect(parseWebEnv(OK)).toEqual({
			databaseUrl: OK.DATABASE_URL,
			payloadSecret: OK.PAYLOAD_SECRET,
			appOrigin: "https://app.sbx.example.com",
			operatorGroups: ["sbx-operators", "admins"],
			sbxDomain: "sbx.example.com",
			apiPublicUrl: "https://api.sbx.example.com",
			logoutUrl: null,
		});
		expect(
			parseWebEnv({ ...OK, SBX_LOGOUT_URL: "https://kc.example.com/logout" })
				.logoutUrl,
		).toBe("https://kc.example.com/logout");
	});

	it("reports every problem at once", () => {
		let err: unknown;
		try {
			parseWebEnv({
				SBX_APP_ORIGIN: "https://app.example.com/",
				SBX_SBX_DOMAIN: "*.bad",
				PAYLOAD_SECRET: "short",
				SBX_LOGOUT_URL: "",
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebEnvError);
		const issues = (err as WebEnvError).issues.join("\n");
		for (const k of [
			"DATABASE_URL",
			"PAYLOAD_SECRET",
			"SBX_APP_ORIGIN",
			"SBX_OPERATOR_GROUPS",
			"SBX_SBX_DOMAIN",
			"SBX_API_PUBLIC_URL",
		]) {
			expect(issues).toContain(k);
		}
		// An empty optional value is absent, not invalid.
		expect(issues).not.toContain("SBX_LOGOUT_URL");
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

	it("sign-out goes through oauth2-proxy, then the IdP logout", () => {
		expect(signOutHref(null)).toBe("/oauth2/sign_out");
		expect(signOutHref("https://kc.example.com/logout?x=1")).toBe(
			"/oauth2/sign_out?rd=https%3A%2F%2Fkc.example.com%2Flogout%3Fx%3D1",
		);
	});
});
