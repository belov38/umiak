import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("homelab MCP compose", () => {
	it("runs behind the owner ingress on the private control network", () => {
		const root = resolve(import.meta.dirname, "../../..");
		const stack = JSON.parse(
			execFileSync(
				"docker",
				[
					"compose",
					"--env-file",
					"compose.dev.env",
					"-f",
					"compose.yaml",
					"-f",
					"compose.dev.yaml",
					"config",
					"--format",
					"json",
				],
				{ cwd: root, encoding: "utf8" },
			),
		);
		const mcp = stack.services.mcp;
		expect(mcp.environment).toMatchObject({
			UMIAK_AUTH_MODE: "owner",
			UMIAK_MCP_API_URL: "http://api:8080",
		});
		expect(mcp.ports ?? []).toEqual([]);
		expect(Object.keys(mcp.networks)).toEqual(["control"]);
		expect(mcp.depends_on.api.condition).toBe("service_healthy");
		expect(Object.keys(stack.services).sort()).toEqual(
			[
				"web-meta",
				"secrets-init",
				"postgres",
				"migrate",
				"web-migrate",
				"worker",
				"api",
				"web",
				"mcp",
				"gateway",
				"gateway-renewal",
				"quickstart",
			].sort(),
		);
	});
});
