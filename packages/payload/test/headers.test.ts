import { describe, expect, it } from "vitest";
import { parseAuthHeaders } from "../src/index.ts";

describe("parseAuthHeaders (S8 §5.2)", () => {
	it("lowercases and trims the email", () => {
		const h = new Headers({
			"X-Auth-Request-Email": "A@B.com ",
			"X-Auth-Request-User": "sub-1",
		});
		expect(parseAuthHeaders(h)).toEqual({
			email: "a@b.com",
			user: "sub-1",
			groups: [],
		});
	});

	it("splits groups by comma, trims, drops empty values and duplicates", () => {
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-groups": "a, b,,a",
			})?.groups,
		).toEqual(["a", "b"]);
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-groups": ["a,b", "c"],
			})?.groups,
		).toEqual(["a", "b", "c"]);
		// Node joins repeated headers with ", ".
		const h = new Headers();
		h.set("x-auth-request-email", "a@b.com");
		h.append("x-auth-request-groups", "a,b");
		h.append("x-auth-request-groups", "c");
		expect(parseAuthHeaders(h)?.groups).toEqual(["a", "b", "c"]);
	});

	it("drops the role:<name> entries of oauth2-proxy's keycloak-oidc provider", () => {
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-groups":
					"role:offline_access,sbx-operators,role:sbx-api:read, role:uma_authorization,devs",
			})?.groups,
		).toEqual(["sbx-operators", "devs"]);
	});

	it("no email is null", () => {
		expect(parseAuthHeaders(new Headers())).toBe(null);
		expect(parseAuthHeaders({ "x-auth-request-email": "  " })).toBe(null);
		expect(
			parseAuthHeaders({
				"x-auth-request-user": "sub",
				"x-auth-request-groups": "a",
			}),
		).toBe(null);
	});

	it("an empty email is no email", () => {
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "",
				"x-auth-request-user": "s",
			}),
		).toBe(null);
		expect(
			parseAuthHeaders(
				new Headers({ "x-auth-request-email": "", "x-auth-request-user": "s" }),
			),
		).toBe(null);
	});

	it("a duplicated email header is no email (never pick one of two)", () => {
		// Headers joins repeated values with ", ".
		const h = new Headers();
		h.append("x-auth-request-email", "a@b.com");
		h.append("x-auth-request-email", "evil@x.com");
		h.set("x-auth-request-user", "s");
		expect(parseAuthHeaders(h)).toBe(null);
		expect(
			parseAuthHeaders({
				"x-auth-request-email": ["a@b.com", "evil@x.com"],
				"x-auth-request-user": "s",
			}),
		).toBe(null);
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com,evil@x.com",
				"x-auth-request-user": "s",
			}),
		).toBe(null);
		// The same name twice in a record (different case) counts as two values.
		expect(
			parseAuthHeaders({
				"X-Auth-Request-Email": "a@b.com",
				"x-auth-request-email": "evil@x.com",
			}),
		).toBe(null);
	});

	it("user and preferredUsername are optional and trimmed; header names are case-insensitive", () => {
		expect(
			parseAuthHeaders({
				"X-Auth-Request-Email": "a@b.com",
				"X-Auth-Request-User": " sub-2 ",
				"X-Auth-Request-Preferred-Username": " alice ",
			}),
		).toEqual({
			email: "a@b.com",
			user: "sub-2",
			groups: [],
			preferredUsername: "alice",
		});
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-user": "",
				"x-auth-request-preferred-username": "",
			}),
		).toEqual({ email: "a@b.com", groups: [] });
	});

	it("a repeated or comma-joined user is no user (resolveSession: subject_required)", () => {
		const h = new Headers();
		h.set("x-auth-request-email", "a@b.com");
		h.append("x-auth-request-user", "sub-1");
		h.append("x-auth-request-user", "sub-evil");
		expect(parseAuthHeaders(h)).toEqual({ email: "a@b.com", groups: [] });
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-user": ["sub-1", "sub-evil"],
			}),
		).toEqual({ email: "a@b.com", groups: [] });
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-user": "sub-1,sub-evil",
			}),
		).toEqual({ email: "a@b.com", groups: [] });
		expect(
			parseAuthHeaders({
				"X-Auth-Request-Email": "a@b.com",
				"X-Auth-Request-User": "sub-1",
				"x-auth-request-user": "sub-evil",
			}),
		).toEqual({ email: "a@b.com", groups: [] });
		// One value next to empty ones is that value.
		expect(
			parseAuthHeaders({
				"x-auth-request-email": "a@b.com",
				"x-auth-request-user": ["", " sub-1 "],
			}),
		).toEqual({ email: "a@b.com", user: "sub-1", groups: [] });
	});
});
