// One end-to-end scenario against the real api (S11 14.4, decision 12 of the
// plan): the MCP tools through an in-memory client, the SDK, a real HTTP
// server of apps/api in process with Postgres, a fake agent behind the
// command and file routes. It catches differences between the fake API of the
// other tests and the real one. The worker is not running: the test plays its
// part with markReady and markStopped.
//
// Needs Postgres like the CLI tests (Docker, or SBX_TEST_DATABASE_URL;
// SBX_TEST_SKIP_PG=1 skips it).
import type { CallToolResult } from "@modelcontextprotocol/server";
import { skipPg } from "@sbx/db/testing";
import { Sbx } from "@sbx/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { createServer } from "../src/server.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { connectInMemory, type InMemoryConnection } from "./helpers/connect.ts";
import { type Answer, answerOf } from "./helpers/harness.ts";
import { type RealApi, startRealApi, until } from "./helpers/real-api.ts";

describe.skipIf(skipPg())("MCP tools against the real api", () => {
	let api: RealApi;
	let conn: InMemoryConnection;
	const logs: string[] = [];

	beforeAll(async () => {
		api = await startRealApi();
		const sbx = new Sbx({ baseUrl: api.url, apiKey: api.secret, env: {} });
		conn = await connectInMemory(
			createServer({
				tools: ALL_TOOLS,
				sbx: () => sbx,
				transport: "stdio",
				log: createLogger({
					level: "debug",
					destination: { write: (l: string) => void logs.push(l) },
				}),
			}),
		);
	});

	afterAll(async () => {
		await conn?.close();
		await api?.close();
	});

	async function call(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<Answer> {
		const raw = (await conn.client.callTool({
			name,
			arguments: args,
		})) as CallToolResult;
		return answerOf(raw);
	}

	/** Runs a waiting call while the "worker" moves the sandbox on once the api has the transition. */
	async function withWorker(
		waiting: Promise<Answer>,
		slug: string,
		from: string,
		mark: (slug: string) => Promise<void>,
	): Promise<Answer> {
		await until(async () =>
			(await api.stateOf(slug)) === from ? true : undefined,
		);
		await mark(slug);
		return waiting;
	}

	it("create -> exec -> files -> port -> stop -> delete", async () => {
		const slug = "mcp-int";

		// create (wait): ready once the worker has marked it
		const created = await withWorker(
			call("sandbox_create", { slug, wait_seconds: 25 }),
			slug,
			"creating",
			api.markReady,
		);
		expect(created.isError, created.texts.join("\n")).toBe(false);
		expect(created.json).toMatchObject({ slug, state: "ready" });
		const id = created.json.id as string;
		expect(id).toMatch(/^sb_/);

		// exec_run: a real process of the fake agent
		const run = await call("exec_run", {
			sandbox: id,
			command: "echo hello-from-mcp; echo oops >&2; exit 3",
		});
		expect(run.isError, run.texts.join("\n")).toBe(false);
		expect(run.json).toMatchObject({ status: "exited", exit_code: 3 });
		const text = run.texts.join("\n");
		expect(text).toContain("hello-from-mcp");
		expect(text).toContain("oops");

		// files_write / files_read
		const body = "line one\nline two with éè\n";
		const wrote = await call("files_write", {
			sandbox: id,
			path: "/home/user/mcp/note.txt",
			content: body,
		});
		expect(wrote.isError, wrote.texts.join("\n")).toBe(false);
		const read = await call("files_read", {
			sandbox: id,
			path: "/home/user/mcp/note.txt",
		});
		expect(read.isError, read.texts.join("\n")).toBe(false);
		expect(read.texts.join("\n")).toContain("line two with éè");
		const edited = await call("files_edit", {
			sandbox: id,
			path: "/home/user/mcp/note.txt",
			old_text: "line one",
			new_text: "LINE ONE",
		});
		expect(edited.isError, edited.texts.join("\n")).toBe(false);

		// port_expose: sso by default, then token
		const sso = await call("port_expose", { sandbox: id, port: 3000 });
		expect(sso.isError, sso.texts.join("\n")).toBe(false);
		expect(sso.json).toMatchObject({ port: 3000, access: "sso" });
		expect(sso.json.url).toMatch(/^https:\/\//);
		const token = await call("port_expose", {
			sandbox: id,
			port: 3000,
			access: "token",
		});
		expect(token.isError, token.texts.join("\n")).toBe(false);
		expect(token.json.url_with_token).toContain("_token=");

		// stop (wait): stopped once the worker has marked it
		const stopped = await withWorker(
			call("sandbox_stop", { sandbox: id, wait: true, wait_seconds: 25 }),
			slug,
			"stopping",
			api.markStopped,
		);
		expect(stopped.isError, stopped.texts.join("\n")).toBe(false);
		expect(stopped.json).toMatchObject({ state: "stopped" });

		// delete: a wrong confirm changes nothing, the right one starts the delete
		const refused = await call("sandbox_delete", {
			sandbox: id,
			confirm: "sb_wrong",
		});
		expect(refused.isError).toBe(true);
		expect(refused.texts[0]).toContain("error: confirmation_required");
		expect(await api.stateOf(slug)).toBe("stopped");
		const deleted = await call("sandbox_delete", { sandbox: id, confirm: id });
		expect(deleted.isError, deleted.texts.join("\n")).toBe(false);
		expect(deleted.json.state).toBe("deleting");
		expect(await api.stateOf(slug)).toBe("deleting");

		// The bearer never reached the log.
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.join("")).not.toContain(api.secret);
	});
});
