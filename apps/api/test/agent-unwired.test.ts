import { randomUUID } from "node:crypto";
import {
	type AgentClient,
	type AgentFetchInit,
	AgentUnavailableError,
} from "@sbx/agent-client";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentApi, UnwiredAgentApi } from "../src/index.ts";

let db: TestDatabase;
beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(() => db.drop());

function client(): {
	client: AgentClient;
	fetches: [string, string, AgentFetchInit][];
	required: [string, string][];
} {
	const fetches: [string, string, AgentFetchInit][] = [];
	const required: [string, string][] = [];
	const c = {
		fetch: async (m: string, p: string, init: AgentFetchInit = {}) => {
			fetches.push([m, p, init]);
			return new Response("body", { status: 206 });
		},
		requireCapability: async (m: string, cap: string) => {
			required.push([m, cap]);
		},
	};
	return { client: c as unknown as AgentClient, fetches, required };
}

async function session(machineId: string, caps: string[] | null) {
	await db.pool.query(
		`INSERT INTO tunnel.tunnel_sessions
		   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id,
		    vmgenid, agent_version, proto_version, capabilities, state, connected_at)
		 VALUES ($1, 'gw-1', 1, 'c', 'a', 'b', 'v', '0.1.0', '1', $2, 'connected', now())`,
		[machineId, caps],
	);
}

describe("UnwiredAgentApi", () => {
	it("reads capabilities from tunnel.tunnel_sessions", async () => {
		const api = new UnwiredAgentApi(client().client, db.pool);
		const m = randomUUID();
		await session(m, ["process.v1", "files.v1"]);
		expect(await api.capabilities(m)).toEqual(["process.v1", "files.v1"]);
		const unknown = randomUUID();
		await session(unknown, null);
		expect(await api.capabilities(unknown)).toEqual([]);
		expect(await api.capabilities(randomUUID())).toEqual([]);
	});

	it("files goes through AgentClient.fetch unchanged", async () => {
		const c = client();
		const api = new UnwiredAgentApi(c.client, db.pool);
		const init: AgentFetchInit = { headers: { Range: "bytes=0-3" } };
		const res = await api.files("m1", "?path=%2Fa", init);
		expect(res.status).toBe(206);
		expect(c.fetches).toEqual([["m1", "?path=%2Fa", init]]);
		await api.requireCapability("m1", "files.v1");
		expect(c.required).toEqual([["m1", "files.v1"]]);
	});

	it("every RPC fails with AgentUnavailableError", async () => {
		const api: AgentApi = new UnwiredAgentApi(client().client, db.pool);
		const calls: Promise<unknown>[] = [
			api.start(
				"m",
				{
					commandId: "c",
					spec: {
						shell: "true",
						cwd: "",
						env: {},
						user: "user",
						stdin: false,
						timeoutMs: 0,
						tags: {},
					},
				},
				{ requestId: "r" },
			),
			api.sendInput("m", {
				commandId: "c",
				inputSessionId: "s",
				seq: 1,
				data: new Uint8Array(),
				closeStdin: false,
			}),
			api.update("m", { commandId: "c", cols: 1, rows: 1 }),
			api.signal("m", { commandId: "c", signal: "INT" }),
			api.kill("m", { commandId: "c" }),
			api.get("m", "c"),
			api.stat("m", { path: "/" }),
			api.list("m", { path: "/" }),
			api.makeDir("m", { path: "/x", requestId: "r" }),
			api.move("m", { src: "/a", dst: "/b", requestId: "r" }),
			api.chmod("m", { path: "/a", requestId: "r" }),
			api.remove("m", { path: "/a", requestId: "r" }),
			api.listPorts("m"),
			api.updateEnv("m", {}, "r"),
			api.updateSecrets("m", { secretEnv: {}, secretFiles: [] }, "r"),
		];
		for (const p of calls) {
			await expect(p).rejects.toBeInstanceOf(AgentUnavailableError);
		}
		const iter = api
			.attach(
				"m",
				{ commandId: "c", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
				new AbortController().signal,
			)
			[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toBeInstanceOf(AgentUnavailableError);
	});
});
