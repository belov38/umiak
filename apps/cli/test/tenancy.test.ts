import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { generateApiKeySecret } from "@umiak/auth/api-key";
import { expect, it } from "vitest";
import { pathsOf, writeConfig } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { cliHome } from "./helpers/run-cli.ts";

const me = {
	user: { id: "usr_local", email: "owner@example.test", name: "Owner" },
	team: { id: "team_internal", name: "Internal team", role: "owner" },
	auth: { kind: "team_key", scopes: ["sandbox:read"] },
};
const sandbox = {
	id: "sb_one",
	slug: "one",
	state: "running",
	template: "linux",
	size: "2gb",
	teamId: "team_internal",
	createdAt: "2026-01-01",
};
const limits = {
	teamId: "team_internal",
	quota: { maxActiveSandboxes: 5, maxRamMb: 8192, maxSavedSnapshots: 10 },
	usage: { activeSandboxes: 0, ramMb: 0, savedSnapshots: 0 },
	remaining: { activeSandboxes: 5, ramMb: 8192, savedSnapshots: 10 },
	canCreate: true,
};

async function fixture(
	tenancy: "single" | "teams" | undefined,
	work: (f: {
		home: ReturnType<typeof cliHome>;
		apiUrl: string;
		invoke: (
			args: string[],
			stdin?: string,
		) => Promise<{ code: number; stdout: string; stderr: string }>;
		metaCalls: () => number;
		requestedTeams: () => (string | undefined)[];
		setMetaFailure: () => void;
	}) => Promise<void>,
) {
	const home = cliHome();
	let calls = 0;
	let failure = false;
	const requestedTeams: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url !== "/v1/meta")
			requestedTeams.push(req.headers["umiak-team"] as string | undefined);
		if (req.url === "/v1/meta") {
			calls++;
			if (failure) res.statusCode = 503;
			res.end(JSON.stringify({ tenancy, authMode: "oidc", oidc: null }));
		} else if (req.url === "/v1/me") res.end(JSON.stringify(me));
		else if (req.url === "/v1/limits") res.end(JSON.stringify(limits));
		else if (req.url?.startsWith("/v1/sandboxes"))
			res.end(JSON.stringify({ data: [sandbox], nextCursor: null }));
		else {
			res.statusCode = 404;
			res.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	writeConfig(pathsOf(home.env), {
		current: "default",
		profiles: { default: { apiUrl, auth: "key" } },
	});
	const invoke = async (args: string[], stdin = "") => {
		let stdout = "",
			stderr = "";
		const code = await runCli({
			argv: args,
			env: {
				...home.env,
				UMIAK_API_KEY: generateApiKeySecret(),
				UMIAK_TEAM: "team_environment",
			},
			stdout: {
				write: (s) => {
					stdout += String(s);
				},
			},
			stderr: {
				write: (s) => {
					stderr += String(s);
				},
			},
			stdin: Readable.from([stdin]),
			isTTY: false,
		});
		return { code, stdout, stderr };
	};
	try {
		await work({
			home,
			apiUrl,
			invoke,
			metaCalls: () => calls,
			requestedTeams: () => requestedTeams,
			setMetaFailure: () => {
				failure = true;
			},
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		home.rm();
	}
}

it.each(["single", "teams", undefined] as const)(
	"uses server tenancy %s for key profiles, JSON and human output",
	async (tenancy) => {
		await fixture(
			tenancy,
			async ({ invoke, home, metaCalls, requestedTeams }) => {
				for (const command of ["whoami", "limits", "ls"]) {
					const reply = await invoke([
						command,
						"--json",
						"--team",
						"team_explicit",
					]);
					expect(reply.code, reply.stderr).toBe(0);
					expect(reply.stdout.includes("team_internal")).toBe(
						tenancy !== "single",
					);
				}
				const human = await invoke(["whoami", "--human"]);
				expect(human.stdout.includes("in team")).toBe(tenancy !== "single");
				const help = await invoke(["--help"]);
				expect(help.stdout.includes("--team <team>")).toBe(
					tenancy !== "single",
				);
				const subhelp = await invoke(["ls", "--help"]);
				expect(subhelp.stdout.includes("--team <team>")).toBe(
					tenancy !== "single",
				);
				expect(subhelp.stdout.includes("of the team")).toBe(
					tenancy !== "single",
				);
				const config = JSON.parse(
					readFileSync(join(home.configDir, "config.json"), "utf8"),
				);
				expect(config.profiles.default.tenancy).toBe(tenancy ?? "teams");
				expect(metaCalls()).toBe(1);
				expect(requestedTeams().slice(0, 3)).toEqual([
					"team_explicit",
					"team_explicit",
					"team_explicit",
				]);
				expect(requestedTeams().at(-1)).toBe("team_environment");
			},
		);
	},
);

it("refreshes expired metadata but retains cached single tenancy when offline", async () => {
	await fixture(
		"single",
		async ({ invoke, home, apiUrl, setMetaFailure, metaCalls }) => {
			writeConfig(pathsOf(home.env), {
				current: "default",
				profiles: {
					default: {
						apiUrl,
						auth: "key",
						tenancy: "single",
						tenancyCheckedAt: 1,
					},
				},
			});
			setMetaFailure();
			expect((await invoke(["whoami", "--json"])).stdout).not.toContain(
				"team_internal",
			);
			expect(metaCalls()).toBe(1);
			expect((await invoke(["--help"])).stdout).not.toContain("--team <team>");
			expect(metaCalls()).toBe(1);
		},
	);
});

it("persists tenancy from anonymous metadata on key login", async () => {
	await fixture("single", async ({ invoke, home, apiUrl }) => {
		const reply = await invoke(
			["login", "--api-url", apiUrl, "--key-stdin", "--json"],
			generateApiKeySecret(),
		);
		expect(reply.code, reply.stderr).toBe(0);
		expect(reply.stdout).not.toContain("team_internal");
		expect(
			JSON.parse(readFileSync(join(home.configDir, "config.json"), "utf8"))
				.profiles.default,
		).toMatchObject({
			auth: "key",
			tenancy: "single",
			tenancyCheckedAt: expect.any(Number),
		});
	});
});

it("refreshes an expired teams cache from current server metadata", async () => {
	await fixture("single", async ({ invoke, home, apiUrl, metaCalls }) => {
		writeConfig(pathsOf(home.env), {
			current: "default",
			profiles: {
				default: { apiUrl, auth: "key", tenancy: "teams", tenancyCheckedAt: 1 },
			},
		});
		expect((await invoke(["whoami", "--json"])).stdout).not.toContain(
			"team_internal",
		);
		expect(metaCalls()).toBe(1);
		expect(
			JSON.parse(readFileSync(join(home.configDir, "config.json"), "utf8"))
				.profiles.default.tenancy,
		).toBe("single");
		expect(
			(await invoke(["--help", "--api-url", "https://another.example.test"]))
				.stdout,
		).toContain("--team <team>");
		expect(metaCalls()).toBe(1);
	});
});
