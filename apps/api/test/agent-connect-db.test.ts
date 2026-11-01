// ConnectAgentApi against Postgres: capabilities from tunnel.tunnel_sessions,
// and without a client (no gateway token) every call is agent_unavailable.
import { randomUUID } from "node:crypto";
import { AgentUnavailableError } from "@umiak/agent-client";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentApi, ConnectAgentApi } from "../src/index.ts";

describe.skipIf(skipPg())("ConnectAgentApi with Postgres", () => {
	let db: TestDatabase;
	beforeAll(async () => {
		db = await createTestDatabase();
	});
	afterAll(() => db?.drop());

	async function session(machineId: string, caps: string[] | null) {
		await db.pool.query(
			`INSERT INTO tunnel.tunnel_sessions
			   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id,
			    vmgenid, agent_version, proto_version, capabilities, state, connected_at)
			 VALUES ($1, 'gw-1', 1, 'c', 'a', 'b', 'v', '0.1.0', '1', $2, 'connected', now())`,
			[machineId, caps],
		);
	}

	it("reads capabilities from tunnel.tunnel_sessions", async () => {
		const api = new ConnectAgentApi(null, db.pool);
		const m = randomUUID();
		await session(m, ["process.v1", "files.v1"]);
		expect(await api.capabilities(m)).toEqual(["process.v1", "files.v1"]);
		const unknown = randomUUID();
		await session(unknown, null);
		expect(await api.capabilities(unknown)).toEqual([]);
		expect(await api.capabilities(randomUUID())).toEqual([]);
	});

	it("without a client every RPC, files and requireCapability fail with AgentUnavailableError", async () => {
		const api: AgentApi = new ConnectAgentApi(null, db.pool);
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
			api.files("m", "?path=%2F", {}),
			api.requireCapability("m", "files.v1"),
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
