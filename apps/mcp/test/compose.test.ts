// Delivery wiring (S11 6.2, 16.3): the `mcp` service of the product compose,
// its dev-cp overlay and the Tailscale Serve mapping. Compose resolution needs
// the Docker CLI only (no daemon); without it the compose cases skip with a
// message.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMPOSE = join(REPO, "deploy", "compose", "compose.yaml");
const DEVCP = join(REPO, "infra", "dev-cp");

const dockerOk =
	spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
if (!dockerOk) {
	process.stderr.write(
		"compose.test: SKIPPED compose cases, `docker compose` is not available\n",
	);
}
const withDocker = it.skipIf(!dockerOk);

interface ComposeService {
	image?: string;
	build?: { context: string; dockerfile: string };
	environment?: Record<string, string>;
	ports?: { host_ip?: string; published: string; target: number }[];
	depends_on?: Record<string, { condition: string }>;
	healthcheck?: { test: string[] };
	networks?: Record<string, unknown>;
	stop_grace_period?: string;
	restart?: string;
}

let dir: string;
let emptyEnv: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "umiak-mcp-compose-"));
	// An empty env file keeps a developer's deploy/compose/.env out of the result.
	emptyEnv = join(dir, "empty.env");
	writeFileSync(emptyEnv, "");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function resolve(
	files: string[],
	env: Record<string, string> = {},
): Record<string, ComposeService> {
	const args = ["compose", "--env-file", emptyEnv];
	for (const f of files) args.push("-f", f);
	args.push("config", "--format", "json");
	const out = execFileSync("docker", args, {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return (JSON.parse(out) as { services: Record<string, ComposeService> })
		.services;
}

function published(s: ComposeService): string[] {
	return (s.ports ?? []).map(
		(p) => `${p.host_ip ?? ""}:${p.published}:${p.target}`,
	);
}

describe("product compose: service mcp", () => {
	withDocker("has the documented environment and loopback ports", () => {
		const mcp = resolve([COMPOSE]).mcp;
		expect(mcp, "service mcp").toBeDefined();
		expect(mcp?.image).toBe("umiak-quickstart:dev");
		expect(mcp?.build?.dockerfile).toBe("deploy/compose/quickstart/Dockerfile");
		const env = mcp?.environment ?? {};
		expect(env.UMIAK_MCP_API_URL).toBe("http://api:8080");
		expect(env.UMIAK_MCP_PUBLIC_URL).toBe("http://localhost:8090/mcp");
		expect(env.UMIAK_OIDC_ISSUER).toBe("http://localhost:8180/realms/umiak");
		expect(env.UMIAK_MCP_ALLOWED_ORIGINS).toBe("");
		expect(published(mcp as ComposeService).sort()).toEqual([
			"127.0.0.1:8090:8080",
			"127.0.0.1:9092:9090",
		]);
	});

	withDocker("waits for a healthy api and checks /readyz on 9090", () => {
		const mcp = resolve([COMPOSE]).mcp as ComposeService;
		expect(mcp.depends_on?.api?.condition).toBe("service_healthy");
		expect(mcp.healthcheck?.test.join(" ")).toContain(
			"http://127.0.0.1:9090/readyz",
		);
		expect(mcp.restart).toBe("unless-stopped");
		expect(mcp.stop_grace_period).toBe("30s");
		expect(Object.keys(mcp.networks ?? {})).toEqual(["umiak"]);
	});

	withDocker("follows UMIAK_MCP_PUBLIC_URL and the issuer of the stack", () => {
		const env =
			resolve([COMPOSE], {
				UMIAK_MCP_PUBLIC_URL: "https://mcp.example.test/mcp",
				UMIAK_KEYCLOAK_URL: "https://kc.example.test",
			}).mcp?.environment ?? {};
		expect(env.UMIAK_MCP_PUBLIC_URL).toBe("https://mcp.example.test/mcp");
		expect(env.UMIAK_OIDC_ISSUER).toBe("https://kc.example.test/realms/umiak");
	});
});

describe("dev-cp", () => {
	const required = {
		UMIAK_DEVCP_DB_PASSWORD: "test-db-password",
		UMIAK_DEVCP_USER_PASSWORD: "test-user-password",
		UMIAK_DEVCP_TURN_IP: "192.0.2.90",
		UMIAK_DEVCP_TURN_HOST: "turn.test",
		UMIAK_DEVCP_TURN_URLS: "turn:turn.test:3478?transport=udp",
		UMIAK_TUNNEL_URL: "wss://tunnel.test/v1/connect",
		UMIAK_PORT_DOMAIN: "umiak.test",
		UMIAK_DEVCP_TUNNEL_HOST: "tunnel.test",
		UMIAK_DEVCP_SSH_HOST: "ts.test",
		UMIAK_GATEWAY_AUTH_URL: "https://ts.test:8443/umiak-auth/authorize",
		UMIAK_KEYCLOAK_URL: "https://ts.test:10000",
		UMIAK_APP_ORIGIN: "https://ts.test:8443",
		UMIAK_OAUTH2_PROXY_REDIRECT_URL: "https://ts.test:8443/oauth2/callback",
		UMIAK_API_PUBLIC_URL: "https://ts.test:8443",
		UMIAK_OIDC_ISSUER: "https://ts.test:10000/realms/umiak",
		UMIAK_DEVCP_TS_NAME: "ts.test",
		// S8 web: sign-out through Keycloak's end-session page.
		UMIAK_LOGOUT_URL:
			"https://ts.test:10000/realms/umiak/protocol/openid-connect/logout",
	};
	const files = [COMPOSE, join(DEVCP, "compose.dev-cp.yaml")];

	withDocker("rotates the stand password for every database consumer", () => {
		const services = resolve(files, {
			...required,
			UMIAK_MCP_PUBLIC_URL: "https://ts.test:8443/mcp",
		});
		for (const name of [
			"migrate",
			"web-migrate",
			"worker",
			"api",
			"web",
			"gateway",
		])
			expect(services[name]?.environment?.DATABASE_URL, name).toBe(
				"postgres://umiak:test-db-password@postgres:5432/umiak",
			);
		for (const [name, key] of [
			["postgres", "POSTGRES_PASSWORD"],
			["keycloak-db", "PGPASSWORD"],
			["keycloak", "KC_DB_PASSWORD"],
		] as const)
			expect(services[name]?.environment?.[key], name).toBe("test-db-password");
	});

	withDocker("takes the public MCP URL from .env", () => {
		const env =
			resolve(files, {
				...required,
				UMIAK_MCP_PUBLIC_URL: "https://ts.test:8443/mcp",
			}).mcp?.environment ?? {};
		expect(env.UMIAK_MCP_PUBLIC_URL).toBe("https://ts.test:8443/mcp");
		expect(env.UMIAK_OIDC_ISSUER).toBe("https://ts.test:10000/realms/umiak");
	});

	withDocker("admits the Serve Host forms and nothing more", () => {
		const env =
			resolve(files, {
				...required,
				UMIAK_MCP_PUBLIC_URL: "https://ts.test:8443/mcp",
			}).mcp?.environment ?? {};
		expect(env.UMIAK_MCP_ALLOWED_HOSTS?.split(",").sort()).toEqual([
			"127.0.0.1:8090",
			"ts.test",
			"ts.test:8443",
		]);
	});

	withDocker("refuses to run with a stale .env (no localhost default)", () => {
		expect(() => resolve(files, required)).toThrow(/UMIAK_MCP_PUBLIC_URL/);
	});

	function names(): { SERVE: string; MCP_URL: string; TS_NAME: string } {
		const out = execFileSync(
			"bash",
			[
				"-c",
				'source "$1"; printf "%s\\n%s\\n%s\\n" "$SERVE" "$MCP_URL" "$TS_NAME"',
				"_",
				join(DEVCP, "names.sh"),
			],
			{
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
			},
		).split("\n");
		return {
			SERVE: out[0] ?? "",
			MCP_URL: out[1] ?? "",
			TS_NAME: out[2] ?? "",
		};
	}

	it("serves /mcp and its protected resource metadata through Serve 8443", () => {
		const { SERVE, MCP_URL, TS_NAME } = names();
		const mappings = SERVE.split(" ");
		expect(mappings).toContain("8443:/mcp=http://127.0.0.1:8090/mcp");
		expect(mappings).toContain(
			"8443:/.well-known/oauth-protected-resource/mcp=http://127.0.0.1:8090/.well-known/oauth-protected-resource/mcp",
		);
		// The pre-existing routes stay.
		expect(mappings).toContain("8443:/v1=http://127.0.0.1:8080/v1");
		expect(MCP_URL).toBe(`https://${TS_NAME}:8443/mcp`);
	});

	it("deploy.sh passes the MCP URL into .env", () => {
		const deploy = readFileSync(join(DEVCP, "deploy.sh"), "utf8");
		expect(deploy).toContain('"MCP_URL=$MCP_URL"');
		expect(deploy).toContain("UMIAK_MCP_PUBLIC_URL=$MCP_URL");
	});
});

describe("deploy.sh checks from the Mac", () => {
	/** `check` and `check_ok` of deploy.sh, run with a fake curl answering `code`. */
	function runCheck(fn: string, code: number, url: string): number {
		const deploy = readFileSync(join(DEVCP, "deploy.sh"), "utf8");
		const start = deploy.indexOf("\ncheck() {");
		const end = deploy.indexOf("\ncheck tunnel ");
		expect(start, "check() in deploy.sh").toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const script = [
			"log() { :; }",
			`curl() { printf 'body\\n${code}'; }`,
			deploy.slice(start, end),
			`${fn} mcp "$1"`,
		].join("\n");
		return (
			spawnSync("bash", ["-c", script, "_", url], {
				env: { PATH: process.env.PATH ?? "" },
			}).status ?? -1
		);
	}

	it("the metadata check of MCP passes on 200 only (a 421 from a wrong Host fails)", () => {
		const url =
			"https://cp.example.ts.net:8443/.well-known/oauth-protected-resource/mcp";
		expect(runCheck("check_ok", 200, url)).toBe(0);
		expect(runCheck("check_ok", 421, url)).not.toBe(0);
		expect(runCheck("check_ok", 404, url)).not.toBe(0);
		// The plain check accepts any HTTP answer (a sign-in redirect is fine).
		expect(runCheck("check", 421, url)).toBe(0);
	});

	it("derives the metadata URL from MCP_URL", () => {
		const deploy = readFileSync(join(DEVCP, "deploy.sh"), "utf8");
		expect(deploy).toContain('check_ok mcp "$MCP_PRM_URL"');
		const line = (name: string) =>
			deploy.split("\n").find((l) => l.startsWith(`${name}=`)) ?? "";
		const out = execFileSync(
			"bash",
			[
				"-c",
				`${line("MCP_ORIGIN")}\n${line("MCP_PRM_URL")}\nprintf %s "$MCP_PRM_URL"`,
			],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					MCP_URL: "https://cp.example.ts.net:9443/x/mcp",
				},
			},
		);
		expect(out).toBe(
			"https://cp.example.ts.net:9443/.well-known/oauth-protected-resource/x/mcp",
		);
	});
});
