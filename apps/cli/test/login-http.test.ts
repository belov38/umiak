import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/program.ts";
import { cliHome } from "./helpers/run-cli.ts";

afterEach(() => vi.unstubAllGlobals());

for (const [origin, warning] of [
	["http://localhost:8080", false],
	["http://127.23.45.67", false],
	["http://[::1]", false],
	["http://10.4.3.2", false],
	["http://172.16.0.1", false],
	["http://172.31.255.255", false],
	["http://192.168.4.2", false],
	["http://169.254.1.2", false],
	["http://100.64.0.1", false],
	["http://100.127.255.254", false],
	["http://[fd7a:115c:a1e0::1]", false],
	["http://boat.tailnet.ts.net", true],
	["http://172.32.0.1", true],
	["http://100.128.0.1", true],
	["http://8.8.8.8", true],
	["http://boat.example.com", true],
	["https://boat.example.com", false],
] as const) {
	it(`HTTP transport warning=${warning} at login to ${origin}, never for later commands`, async () => {
		const home = cliHome();
		let stderr = "";
		vi.stubGlobal("fetch", async (req: Request) =>
			Response.json(
				req.url.endsWith("/meta")
					? { authMode: "none", tenancy: "single", oidc: null }
					: {
							user: { id: "local", email: "local@localhost" },
							team: { id: "team_local" },
							auth: { kind: "local", scopes: [] },
						},
			),
		);
		const run = (argv: string[]) =>
			runCli({
				argv: [...argv, "--json"],
				env: home.env,
				stdin: Readable.from([]),
				isTTY: false,
				stdout: { write: () => {} },
				stderr: {
					write: (s) => {
						stderr += String(s);
					},
				},
			});
		try {
			expect(await run(["login", "--api-url", origin]), stderr).toBe(0);
			expect(stderr.match(/HTTP.*unencrypted/g) ?? []).toHaveLength(
				warning ? 1 : 0,
			);
			stderr = "";
			expect(await run(["whoami"]), stderr).toBe(0);
			expect(stderr).not.toMatch(/HTTP.*unencrypted/);
		} finally {
			home.rm();
		}
	});
}
