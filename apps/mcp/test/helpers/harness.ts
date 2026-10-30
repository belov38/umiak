// Tool tests: the real tool list on an in-memory MCP connection, backed by the
// fake API. The fake's contract errors are asserted empty by `close()`.
//
//   const h = await startHarness();           // afterEach: await h.close()
//   const r = await h.call("sandbox_get", { sandbox: "sb_..." });
//   r.json   // the JSON header of the first text block
//   r.lines  // the text blocks after the header
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Sbx } from "@sbx/sdk";
import { expect } from "vitest";
import { createLogger } from "../../src/log.ts";
import { createServer, type ServerOptions } from "../../src/server.ts";
import { ALL_TOOLS } from "../../src/tools/index.ts";
import {
	FAKE_TOKENS,
	type FakeApi,
	type FakeApiOptions,
	startFakeApi,
} from "../fake-api/index.ts";
import { connectInMemory, type InMemoryConnection } from "./connect.ts";

export interface RecordedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Headers;
	/** Parsed JSON body; undefined when there is none. */
	body: unknown;
}

export interface Answer {
	isError: boolean;
	/** Text of every text block. */
	texts: string[];
	/** Blocks after the first, joined. */
	lines: string;
	/** The first block parsed as JSON (undefined when it is not JSON). */
	// biome-ignore lint/suspicious/noExplicitAny: loose JSON in assertions
	json: any;
	raw: CallToolResult;
}

export interface Harness {
	api: FakeApi;
	conn: InMemoryConnection;
	sbx: Sbx;
	requests: RecordedRequest[];
	logs: Record<string, unknown>[];
	call(
		name: string,
		args?: Record<string, unknown>,
		opts?: { onprogress?: (p: { progress: number }) => void },
	): Promise<Answer>;
	/** Requests to `path` (exact, without query) in order. */
	to(method: string, path: string): RecordedRequest[];
	close(): Promise<void>;
}

export interface HarnessOptions {
	api?: FakeApiOptions;
	token?: string;
	server?: Partial<ServerOptions>;
}

export function answerOf(raw: CallToolResult): Answer {
	const texts = raw.content.map((b) => (b.type === "text" ? b.text : ""));
	let json: unknown;
	try {
		json = JSON.parse(texts[0] ?? "");
	} catch {
		json = undefined;
	}
	return {
		isError: raw.isError === true,
		texts,
		lines: texts.slice(1).join("\n"),
		json,
		raw,
	};
}

export async function startHarness(o: HarnessOptions = {}): Promise<Harness> {
	const api = await startFakeApi(o.api);
	const requests: RecordedRequest[] = [];
	const recordingFetch: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const text = await req.clone().text();
		requests.push({
			method: req.method,
			path: new URL(req.url).pathname,
			query: new URL(req.url).searchParams,
			headers: req.headers,
			body: text === "" ? undefined : JSON.parse(text),
		});
		return fetch(req);
	};
	const sbx = new Sbx({
		baseUrl: api.url,
		apiKey: o.token ?? FAKE_TOKENS.full,
		env: {},
		fetch: recordingFetch,
	});
	const logs: Record<string, unknown>[] = [];
	const log = createLogger({
		level: "debug",
		destination: { write: (line: string) => logs.push(JSON.parse(line)) },
	});
	const conn = await connectInMemory(
		createServer({
			tools: ALL_TOOLS,
			sbx: () => sbx,
			transport: "stdio",
			log,
			...o.server,
		}),
	);
	return {
		api,
		conn,
		sbx,
		requests,
		logs,
		async call(name, args = {}, opts = {}) {
			const raw = (await conn.client.callTool(
				{ name, arguments: args },
				opts.onprogress === undefined
					? undefined
					: { onprogress: opts.onprogress },
			)) as CallToolResult;
			return answerOf(raw);
		},
		to: (method, path) =>
			requests.filter((r) => r.method === method && r.path === path),
		async close() {
			await conn.close();
			await api.close();
			expect(api.contractErrors).toEqual([]);
			expect(conn.errors).toEqual([]);
		},
	};
}
