import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/program.ts";
import { cliHome } from "./helpers/run-cli.ts";

const home = cliHome();
afterEach(() => home.rm());
it("logs in without credentials and saves a tokenless local profile", async () => {
	const calls: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		calls.push(req.headers.authorization);
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify(
				req.url?.endsWith("/meta")
					? { authMode: "none", tenancy: "single", oidc: null }
					: {
							user: { id: "local", email: "local@localhost" },
							team: { id: "team_local" },
							auth: { kind: "local", scopes: [] },
						},
			),
		);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	let output = "";
	let result: number;
	try {
		result = await runCli({
			argv: ["login", "--api-url", apiUrl, "--json"],
			env: home.env,
			stdin: Readable.from([]),
			isTTY: false,
			stdout: {
				write: (s) => {
					output += String(s);
				},
			},
			stderr: { write: () => {} },
		});
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
	expect(result).toBe(0);
	expect(output).toContain("logged_in");
	expect(
		JSON.parse(readFileSync(join(home.configDir, "config.json"), "utf8"))
			.profiles.default,
	).toEqual({
		apiUrl,
		auth: "none",
		tenancy: "single",
		tenancyCheckedAt: expect.any(Number),
	});
	expect(existsSync(join(home.configDir, "credentials.json"))).toBe(false);
	expect(calls).toEqual([undefined, undefined]);
});
