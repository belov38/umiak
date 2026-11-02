import { describe, expect, it } from "vitest";
import { ownerLogin } from "../src/auth/owner-login.ts";

describe("owner pairing", () => {
	it("waits for browser approval and only polls with its private secret", async () => {
		let polls = 0;
		const seen: string[] = [];
		const codes: unknown[] = [];
		const token = await ownerLogin({
			apiUrl: "https://umiak.test",
			fetch: async (req) => {
				seen.push(req.url);
				if (req.url.endsWith("/owner/pair"))
					return Response.json({
						id: "request-id",
						secret: "private",
						expiresIn: 300,
						interval: 0,
					});
				expect(await req.json()).toEqual({
					id: "request-id",
					secret: "private",
				});
				return Response.json(
					++polls === 1 ? { pending: true } : { token: "owner-token" },
				);
			},
			onCode: (code) => codes.push(code),
			sleep: async () => {},
		});
		expect(token).toBe("owner-token");
		expect(polls).toBe(2);
		expect(codes).toEqual([
			{
				id: "request-id",
				verificationUri: "https://umiak.test/owner/pair?id=request-id",
				expiresIn: 300,
			},
		]);
		expect(JSON.stringify(codes)).not.toContain("private");
	});
	it("rejects pairing endpoints redirecting outside the deployment", async () => {
		await expect(
			ownerLogin({
				apiUrl: "https://umiak.test",
				fetch: async (req) => {
					expect(req.redirect).toBe("error");
					return Response.json(
						{ error: { code: "invalid_pair", message: "expired" } },
						{ status: 403 },
					);
				},
				onCode: () => {},
			}),
		).rejects.toThrow("expired");
	});
});
