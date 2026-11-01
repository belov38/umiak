import type { CallToolResult } from "@modelcontextprotocol/server";
import { Umiak, UmiakError } from "@umiak/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	CALL_BUDGET_MS,
	Deadline,
	RESPONSE_MARGIN_MS,
} from "../src/deadline.ts";
import { ToolError } from "../src/errors.ts";
import {
	pinnedInstructions,
	SERVER_INSTRUCTIONS,
} from "../src/instructions.ts";
import { createLogger } from "../src/log.ts";
import { MAX_RESULT_CHARS, toolText } from "../src/output/result.ts";
import { lintToolSchema } from "../src/schema-rules.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { MCP_VERSION } from "../src/version.ts";
import {
	connectInMemory,
	type Era,
	type InMemoryConnection,
	TEST_CLIENT_INFO,
} from "./helpers/connect.ts";
import { type FakeTools, fakeTools } from "./helpers/fake-tools.ts";

const ERAS: Era[] = ["modern", "legacy"];

interface Setup {
	conn: InMemoryConnection;
	fake: FakeTools;
	logs: Record<string, unknown>[];
	opts: ServerOptions;
}

const open: InMemoryConnection[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const c of open.splice(0)) await c.close();
});

async function setup(
	overrides: Partial<ServerOptions> = {},
	era: Era = "modern",
): Promise<Setup> {
	const fake = fakeTools();
	const logs: Record<string, unknown>[] = [];
	const log = createLogger({
		level: "debug",
		destination: { write: (line: string) => logs.push(JSON.parse(line)) },
	});
	const umiak = new Umiak({
		baseUrl: "http://127.0.0.1:9",
		apiKey: "k",
		env: {},
	});
	const opts: ServerOptions = {
		tools: fake.tools,
		umiak: () => umiak,
		transport: "stdio",
		log,
		...overrides,
	};
	const conn = await connectInMemory(createServer(opts), { era });
	open.push(conn);
	return { conn, fake, logs, opts };
}

function text(r: unknown): string {
	const content = (r as CallToolResult).content;
	return content
		.map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
		.join("\n");
}

function callLines(logs: Record<string, unknown>[]) {
	return logs.filter((l) => l.msg === "tool call");
}

describe.each(ERAS)("tools/list (%s era)", (era) => {
	it("lists the tools in array order with all four annotations", async () => {
		const { conn, fake } = await setup({}, era);
		const listed = await conn.client.listTools();
		expect(listed.tools.map((t) => t.name)).toEqual([
			"fake_get",
			"fake_delete",
			"fake_create",
			"fake_write",
		]);
		for (const t of listed.tools) {
			const def = fake.tools.find((d) => d.name === t.name);
			expect(t.title).toBe(def?.title);
			expect(t.description).toBe(def?.description);
			expect(t.annotations).toEqual(def?.annotations);
		}
	});

	it("reports name, version and instructions", async () => {
		const { conn } = await setup({}, era);
		expect(conn.client.getProtocolEra()).toBe(era);
		expect(conn.client.getServerVersion()).toMatchObject({
			name: "umiak",
			version: MCP_VERSION,
		});
		expect(conn.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
	});

	it("publishes schemas that pass the 7.2 linter, sandbox first and required", async () => {
		const { conn } = await setup({}, era);
		const listed = await conn.client.listTools();
		for (const t of listed.tools) {
			expect(lintToolSchema(t.name, t.inputSchema)).toEqual([]);
		}
		const get = listed.tools.find((t) => t.name === "fake_get");
		expect(Object.keys(get?.inputSchema.properties ?? {})[0]).toBe("sandbox");
		expect(get?.inputSchema.required).toContain("sandbox");
		const create = listed.tools.find((t) => t.name === "fake_create");
		expect(create?.inputSchema.properties).not.toHaveProperty("sandbox");
	});

	it("filters the list by toolsets, read-only and principal", async () => {
		const { conn } = await setup(
			{
				toolsets: ["core", "files"],
				principal: { kind: "team_key", scopes: ["sandboxes:read"] },
			},
			era,
		);
		const listed = await conn.client.listTools();
		expect(listed.tools.map((t) => t.name)).toEqual(["fake_get"]);
	});
});

describe("cache hints", () => {
	it("tools/list carries ttlMs 1 h and cacheScope private on 2026-07-28", async () => {
		const { conn } = await setup({}, "modern");
		const listed = await conn.client.listTools();
		expect(listed).toMatchObject({ ttlMs: 3_600_000, cacheScope: "private" });
	});

	it("tools/list has no cache fields on 2025-11-25", async () => {
		const { conn } = await setup({}, "legacy");
		const listed = await conn.client.listTools();
		expect(listed).not.toHaveProperty("ttlMs");
		expect(listed).not.toHaveProperty("cacheScope");
	});
});

describe.each(ERAS)("pinned mode (%s era)", (era) => {
	it("hides pinned-hidden tools and drops sandbox from the schemas", async () => {
		const { conn } = await setup({ pinnedSandbox: "sb_pinned" }, era);
		const listed = await conn.client.listTools();
		expect(listed.tools.map((t) => t.name)).toEqual([
			"fake_get",
			"fake_delete",
			"fake_write",
		]);
		for (const t of listed.tools) {
			expect(t.inputSchema.properties ?? {}).not.toHaveProperty("sandbox");
			expect(lintToolSchema(t.name, t.inputSchema)).toEqual([]);
		}
	});

	it("substitutes the pinned sandbox in the call", async () => {
		const { conn, fake } = await setup({ pinnedSandbox: "sb_pinned" }, era);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { path: "/a" },
		});
		expect(r.isError).toBeFalsy();
		expect(fake.calls[0]?.args).toEqual({ sandbox: "sb_pinned", path: "/a" });
		expect(fake.calls[0]?.ctx.sandbox("sb_other")).toBe("sb_pinned");
	});

	it("ignores a foreign sandbox argument and uses the pinned one", async () => {
		const { conn, fake, logs } = await setup(
			{ pinnedSandbox: "sb_pinned" },
			era,
		);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_other", path: "/a" },
		});
		expect(r.isError).toBeFalsy();
		expect(fake.calls[0]?.args).toEqual({ sandbox: "sb_pinned", path: "/a" });
		expect(callLines(logs)[0]).toMatchObject({ sandbox: "sb_pinned" });
	});

	it("sends the pinned instructions that name the sandbox and no hidden tool", async () => {
		const { conn } = await setup({ pinnedSandbox: "sb_pinned" }, era);
		const text = conn.client.getInstructions() ?? "";
		expect(text).toBe(pinnedInstructions("sb_pinned"));
		expect(text).toContain("sb_pinned");
		for (const hidden of [
			"sandbox_create",
			"sandbox_list",
			"sandbox_fork",
			"sandbox_delete",
			"snapshot_delete",
		]) {
			expect(text).not.toContain(hidden);
		}
	});

	it("error hints name no hidden tool and no sandbox argument", async () => {
		const hidden = [
			"sandbox_create",
			"sandbox_list",
			"sandbox_fork",
			"sandbox_delete",
			"snapshot_delete",
			"sandbox=",
		];
		for (const code of ["sandbox_not_ready", "not_found", "quota_exceeded"]) {
			const { conn, fake } = await setup({ pinnedSandbox: "sb_pinned" }, era);
			fake.behaviour = async () => {
				throw new UmiakError({
					status: code === "quota_exceeded" ? 403 : 409,
					code,
					message: code,
					retryable: false,
				});
			};
			const r = await conn.client.callTool({
				name: "fake_get",
				arguments: { path: "/a" },
			});
			const t = text(r);
			expect(t).toContain(`error: ${code}`);
			expect(t).toContain("hint: ");
			for (const h of hidden) expect(t, code).not.toContain(h);
		}
		const { conn, fake } = await setup({ pinnedSandbox: "sb_pinned" }, era);
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 409,
				code: "sandbox_not_ready",
				message: "stopped",
				retryable: false,
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { path: "/a" },
		});
		expect(text(r)).toContain("hint: call sandbox_resume and retry.");
	});

	it("a hidden tool is an unknown tool (JSON-RPC error), never executed", async () => {
		const { conn, fake } = await setup({ pinnedSandbox: "sb_pinned" }, era);
		await expect(
			conn.client.callTool({
				name: "fake_create",
				arguments: { template: "ubuntu" },
			}),
		).rejects.toThrow(/fake_create not found/);
		expect(fake.calls).toEqual([]);
	});
});

describe.each(ERAS)("tools/call (%s era)", (era) => {
	it("passes parsed args with the sandbox to the handler", async () => {
		const { conn, fake } = await setup({}, era);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/etc", wait_seconds: 3 },
		});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(text(r))).toEqual({
			tool: "fake_get",
			args: { sandbox: "sb_1", path: "/etc", wait_seconds: 3 },
		});
		expect(fake.calls[0]?.ctx.sandbox("sb_1")).toBe("sb_1");
		expect(fake.calls[0]?.ctx.transport).toBe("stdio");
	});

	it("an argument error is a tool result with isError, the handler not called", async () => {
		const { conn, fake } = await setup({}, era);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "", path: "/etc" },
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("sandbox");
		const missing = await conn.client.callTool({
			name: "fake_get",
			arguments: { path: "/etc" },
		});
		expect(missing.isError).toBe(true);
		expect(fake.calls).toEqual([]);
	});

	it("an unregistered tool is a JSON-RPC error", async () => {
		const { conn } = await setup({}, era);
		await expect(
			conn.client.callTool({ name: "nope", arguments: {} }),
		).rejects.toThrow(/nope not found/);
	});

	it("builds the User-Agent from clientInfo and the transport", async () => {
		const { conn, fake } = await setup({}, era);
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(fake.calls[0]?.ctx.userAgent).toBe(
			`umiak-mcp/${MCP_VERSION} (${TEST_CLIENT_INFO.name}/${TEST_CLIENT_INFO.version}; stdio)`,
		);
	});
});

describe("registration", () => {
	it("refuses a sandboxArg tool whose shape has its own sandbox", () => {
		const fake = fakeTools();
		const [get] = fake.tools;
		if (get === undefined) throw new Error("fixture");
		const bad = {
			...get,
			shape: { ...get.shape, sandbox: z.string().describe("x") },
		};
		expect(() =>
			createServer({
				tools: [bad],
				umiak: () => {
					throw new Error("unused");
				},
				transport: "stdio",
				log: createLogger({ level: "silent" }),
			}),
		).toThrow(/fake_get.*sandbox/);
	});

	it("publishes a string dictionary without propertyNames", async () => {
		const fake = fakeTools();
		const [get] = fake.tools;
		if (get === undefined) throw new Error("fixture");
		const withEnv = {
			...get,
			shape: {
				...get.shape,
				env: z.record(z.string(), z.string()).optional().describe("Env"),
			},
		};
		const { conn } = await setup({ tools: [withEnv] });
		const listed = await conn.client.listTools();
		const schema = listed.tools[0]?.inputSchema;
		expect(schema?.properties?.env).toEqual({
			type: "object",
			additionalProperties: { type: "string" },
			description: "Env",
		});
		expect(lintToolSchema("fake_get", schema)).toEqual([]);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/", env: { A: 1 } },
		});
		expect(r.isError).toBe(true);
	});
});

describe("tool context", () => {
	it("ctx.umiak() is the factory's client, read lazily", async () => {
		const umiak = new Umiak({
			baseUrl: "http://127.0.0.1:9",
			apiKey: "k",
			env: {},
		});
		const factory = vi.fn(() => umiak);
		const { conn, fake } = await setup({ umiak: factory });
		fake.behaviour = async ({ ctx }) => {
			expect(factory).not.toHaveBeenCalled();
			expect(ctx.umiak()).toBe(umiak);
			expect(ctx.umiak()).toBe(umiak);
			return toolText({ ok: true });
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBeFalsy();
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("ctx.umiak() throwing not_logged_in becomes the tool error", async () => {
		const { conn, fake } = await setup({
			umiak: () => {
				throw new ToolError({
					code: "not_logged_in",
					message: "not logged in",
				});
			},
		});
		fake.behaviour = async ({ ctx }) => {
			ctx.umiak();
			return toolText({});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("error: not_logged_in");
		expect(text(r)).toContain("umiak login");
	});

	it("ctx.call carries the deadline signal and the remaining time", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async ({ ctx }) => {
			expect(ctx.call.signal).toBe(ctx.deadline.signal);
			// SDK retries end before the response margin.
			const first = ctx.call.retryBudgetMs;
			expect(first).toBeGreaterThan(
				CALL_BUDGET_MS - RESPONSE_MARGIN_MS - 5_000,
			);
			expect(first).toBeLessThanOrEqual(CALL_BUDGET_MS - RESPONSE_MARGIN_MS);
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(
				now + CALL_BUDGET_MS - RESPONSE_MARGIN_MS / 2,
			);
			expect(ctx.call.retryBudgetMs).toBe(0);
			vi.restoreAllMocks();
			await new Promise((r) => setTimeout(r, 20));
			expect(ctx.call.retryBudgetMs).toBeLessThan(first);
			return toolText({});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBeFalsy();
	});

	it("disposes the deadline after every call", async () => {
		const dispose = vi.spyOn(Deadline.prototype, "dispose");
		const { conn, fake } = await setup();
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		fake.behaviour = async () => {
			throw new Error("boom");
		};
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it("progress reaches the client when it sent a progressToken", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async ({ ctx }) => {
			await ctx.progress(1, 3, "waiting");
			await ctx.progress(2);
			return toolText({});
		};
		const seen: unknown[] = [];
		await conn.client.callTool(
			{ name: "fake_get", arguments: { sandbox: "sb_1", path: "/" } },
			{ onprogress: (p) => seen.push(p) },
		);
		expect(seen).toEqual([
			{ progress: 1, total: 3, message: "waiting" },
			{ progress: 2 },
		]);
	});

	it("progress is a no-op without a progressToken", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async ({ ctx }) => {
			await ctx.progress(1, 3);
			return toolText({ ok: true });
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBeFalsy();
	});

	it("cancelledByClient asks the transport hook with the request id", async () => {
		const asked: (string | number)[] = [];
		const { conn, fake } = await setup({
			wasCancelledByClient: (id) => {
				asked.push(id);
				return true;
			},
		});
		fake.behaviour = async ({ ctx }) => {
			expect(ctx.cancelledByClient()).toBe(true);
			return toolText({});
		};
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(asked).toHaveLength(1);
	});

	it("cancelledByClient is false without the hook", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async ({ ctx }) => {
			expect(ctx.cancelledByClient()).toBe(false);
			return toolText({});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBeFalsy();
	});

	it("reports http as the transport", async () => {
		const { conn, fake } = await setup({ transport: "http" });
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(fake.calls[0]?.ctx.transport).toBe("http");
		expect(fake.calls[0]?.ctx.userAgent).toMatch(/; http\)$/);
	});
});

describe("errors", () => {
	it("an UmiakError becomes the error result, hint names the sandbox of the args", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 409,
				code: "sandbox_not_ready",
				message: "Sandbox is stopped.",
				retryable: false,
				requestId: "req_1",
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_abc", path: "/" },
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("error: sandbox_not_ready");
		expect(text(r)).toContain('sandbox="sb_abc"');
		expect(text(r)).toContain("request_id: req_1");
	});

	it("a ToolError keeps its code and hint", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async () => {
			throw new ToolError({
				code: "invalid_argument",
				message: "bad path",
				hint: "use an absolute path.",
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "x" },
		});
		expect(text(r)).toContain("error: invalid_argument");
		expect(text(r)).toContain("hint: use an absolute path.");
	});

	it("API 401 over HTTP calls onAuthFailure and answers unauthorized, retryable", async () => {
		const onAuthFailure = vi.fn();
		const { conn, fake } = await setup({ onAuthFailure, transport: "http" });
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 401,
				code: "token_expired",
				message: "token expired",
				retryable: false,
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(onAuthFailure).toHaveBeenCalledTimes(1);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("error: unauthorized");
		expect(text(r)).toContain("message: retry the call");
		expect(text(r)).toContain("retryable: true");
	});

	it("API 401 over stdio answers unauthorized with a re-login hint, not retryable", async () => {
		const { conn, fake } = await setup({ transport: "stdio" });
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 401,
				code: "unauthorized",
				message: "invalid credentials",
				retryable: false,
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("error: unauthorized");
		expect(text(r)).toContain("retryable: false");
		expect(text(r)).toContain("run `umiak login` in a terminal");
		expect(text(r)).not.toContain("retry the call");
	});

	it("unauthorizedHint replaces the stdio 401 hint", async () => {
		const { conn, fake } = await setup({
			transport: "stdio",
			unauthorizedHint: "fix UMIAK_API_KEY and restart the MCP server.",
		});
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 401,
				code: "api_key_expired",
				message: "expired",
				retryable: false,
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(text(r)).toContain(
			"hint: fix UMIAK_API_KEY and restart the MCP server.",
		);
		expect(text(r)).toContain("retryable: false");
	});

	it("an unknown error is logged with its stack, without arguments, and answered internal", async () => {
		const { conn, fake, logs } = await setup();
		fake.behaviour = async () => {
			throw new Error("kaboom inside");
		};
		const r = await conn.client.callTool({
			name: "fake_write",
			arguments: { sandbox: "sb_1", path: "/f", content: "SECRET-CONTENT" },
		});
		expect(text(r)).toContain("error: internal");
		expect(text(r)).not.toContain("kaboom");
		const errors = logs.filter((l) => l.level === 50);
		expect(errors).toHaveLength(1);
		const err = errors[0]?.err as { message: string; stack: string };
		expect(err.message).toBe("kaboom inside");
		expect(err.stack).toContain("kaboom inside");
		expect(JSON.stringify(logs)).not.toContain("SECRET-CONTENT");
	});

	it("deadline expiry is deadline_exceeded, retryable", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async ({ ctx }) => {
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + CALL_BUDGET_MS + 1);
			expect(ctx.deadline.expired()).toBe(true);
			throw new Error("x");
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		vi.restoreAllMocks();
		expect(text(r)).toContain("error: deadline_exceeded");
		expect(text(r)).toContain("retryable: true");
	});

	it.each([
		["AbortError", () => new DOMException("aborted", "AbortError")],
		["TimeoutError", () => new DOMException("timed out", "TimeoutError")],
		[
			"an Error named TimeoutError",
			() => Object.assign(new Error("t"), { name: "TimeoutError" }),
		],
	])(
		"%s with no expiry and no cancel is internal, logged once",
		async (_, make) => {
			const { conn, fake, logs } = await setup();
			fake.behaviour = async () => {
				throw make();
			};
			const r = await conn.client.callTool({
				name: "fake_get",
				arguments: { sandbox: "sb_1", path: "/" },
			});
			expect(text(r)).toContain("error: internal");
			expect(text(r)).not.toContain("deadline_exceeded");
			expect(logs.filter((l) => l.level === 50)).toHaveLength(1);
		},
	);

	it("a ToolError raised after the deadline keeps the handler's own error", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async () => {
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + CALL_BUDGET_MS + 1);
			throw new ToolError({
				code: "deadline_exceeded",
				message: "the action may have started",
				retryable: true,
				idempotencyKey: "k-1",
			});
		};
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		vi.restoreAllMocks();
		expect(text(r)).toContain("idempotency_key: k-1");
	});

	it("client cancel aborts the handler's signal and is logged as cancelled", async () => {
		const { conn, fake, logs } = await setup();
		let cancelled: boolean | undefined;
		fake.behaviour = ({ ctx }) =>
			new Promise((_, reject) => {
				ctx.call.signal.addEventListener("abort", () => {
					cancelled = ctx.deadline.cancelled();
					reject(ctx.call.signal.reason);
				});
			});
		const ac = new AbortController();
		const pending = conn.client.callTool(
			{ name: "fake_get", arguments: { sandbox: "sb_1", path: "/" } },
			{ signal: ac.signal },
		);
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
		ac.abort();
		await expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(callLines(logs)).toHaveLength(1));
		expect(cancelled).toBe(true);
		expect(callLines(logs)[0]).toMatchObject({ code: "cancelled" });
	});
});

describe("concurrency slot", () => {
	it("no slot is rate_limited, retryable, and the handler is not called", async () => {
		const { conn, fake } = await setup({ acquireSlot: () => null });
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(text(r)).toContain("error: rate_limited");
		expect(text(r)).toContain("retryable: true");
		expect(fake.calls).toEqual([]);
	});

	it("the slot is released after success and after an error", async () => {
		const release = vi.fn();
		const { conn, fake } = await setup({ acquireSlot: () => release });
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(release).toHaveBeenCalledTimes(1);
		fake.behaviour = async () => {
			throw new Error("x");
		};
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(release).toHaveBeenCalledTimes(2);
	});
});

describe("result cap and call log", () => {
	it("caps a huge result", async () => {
		const { conn, fake } = await setup();
		fake.behaviour = async () =>
			toolText({}, ["x".repeat(MAX_RESULT_CHARS * 2)]);
		const r = await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_1", path: "/" },
		});
		expect(text(r).length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 10);
		expect(text(r)).toContain("response cut at");
	});

	it("logs tool, sandbox, command_id, duration and error code, never the arguments", async () => {
		const { conn, fake, logs } = await setup();
		fake.behaviour = async () =>
			toolText({ command_id: "cmd_1", status: "running" });
		await conn.client.callTool({
			name: "fake_write",
			arguments: { sandbox: "sb_1", path: "/p", content: "TOP-SECRET" },
		});
		fake.behaviour = async () => {
			throw new UmiakError({
				status: 404,
				code: "path_not_found",
				message: "no such file",
				retryable: false,
				requestId: "req_9",
			});
		};
		await conn.client.callTool({
			name: "fake_get",
			arguments: { sandbox: "sb_2", path: "/q" },
		});
		const lines = callLines(logs);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			tool: "fake_write",
			sandbox: "sb_1",
			commandId: "cmd_1",
		});
		expect(typeof lines[0]?.durationMs).toBe("number");
		expect(lines[0]).not.toHaveProperty("code");
		expect(lines[1]).toMatchObject({
			tool: "fake_get",
			sandbox: "sb_2",
			code: "path_not_found",
			requestId: "req_9",
		});
		const all = JSON.stringify(logs);
		expect(all).not.toContain("TOP-SECRET");
		expect(all).not.toContain('"/p"');
	});
});
