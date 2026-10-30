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
});
