import { AgentOutdatedError, AgentUnavailableError } from "@sbx/agent-client";
import { SbxError } from "@sbx/core";
import { describe, expect, it } from "vitest";
import {
	AgentCallError,
	ApiError,
	agentErrorToHttp,
	agentFileInfoJson,
	agentHttpError,
	filesQuery,
	parseAgentFileInfo,
} from "../src/index.ts";

// Agent codes (S3 §11.1, §9) → public status, code, retryable (S7 §5.5).
const TABLE: [agentCode: string, status: number, code: string][] = [
	["path_not_found", 404, "path_not_found"],
	["upload_not_found", 404, "upload_not_found"],
	["command_not_found", 404, "not_found"],
	["not_found", 404, "not_found"],
	["permission_denied", 403, "path_forbidden"],
	["not_directory", 409, "not_directory"],
	["is_directory", 409, "is_directory"],
	["cross_device", 409, "cross_device"],
	["already_exists", 409, "already_exists"],
	["command_exited", 409, "command_exited"],
	["upload_offset_mismatch", 409, "upload_offset_mismatch"],
	["no_space", 507, "no_space"],
	["payload_too_large", 413, "payload_too_large"],
	["invalid_path", 400, "invalid_path"],
	["checksum_mismatch", 422, "checksum_mismatch"],
	["range_not_satisfiable", 416, "range_not_satisfiable"],
	["invalid_argument", 400, "validation"],
	["too_many_commands", 409, "invalid_state"],
];

describe("agentErrorToHttp", () => {
	it.each(TABLE)("%s → %i %s", (agentCode, status, code) => {
		const e = agentErrorToHttp(new AgentCallError(agentCode, "boom"));
		expect(e).toBeInstanceOf(ApiError);
		expect(e.status).toBe(status);
		expect(e.code).toBe(code);
		expect(e.retryable).toBe(false);
	});

	it("invalid_argument carries validation issues", () => {
		const e = agentErrorToHttp(
			new AgentCallError("invalid_argument", "depth 9 is above 8"),
		);
		expect(e.details).toEqual({
			issues: [{ path: "", message: "depth 9 is above 8" }],
		});
	});

	it("too_many_commands → invalid_state with details.reason", () => {
		const e = agentErrorToHttp(new AgentCallError("too_many_commands", "x"));
		expect(e.details).toEqual({ reason: "too_many_commands" });
	});

	it("upload_offset_mismatch carries details.offset and Sbx-Upload-Offset", () => {
		const e = agentErrorToHttp(
			new AgentCallError("upload_offset_mismatch", "x", { offset: 4096 }),
		);
		expect(e.details).toEqual({ offset: 4096 });
		expect(e.headers).toEqual({ "Sbx-Upload-Offset": "4096" });
	});

	it("archive errors keep details.entriesWritten", () => {
		const e = agentErrorToHttp(
			new AgentCallError("invalid_path", "../x", { entriesWritten: 3 }),
		);
		expect(e.details).toEqual({ entriesWritten: 3 });
	});

	it("AgentUnavailableError → 503 agent_unavailable, retryable", () => {
		const e = agentErrorToHttp(new AgentUnavailableError("m1"));
		expect([e.status, e.code, e.retryable]).toEqual([
			503,
			"agent_unavailable",
			true,
		]);
	});

	it("AgentOutdatedError → 409 agent_outdated with details.capability", () => {
		const e = agentErrorToHttp(
			new AgentOutdatedError("m1", "files.archive.v1"),
		);
		expect([e.status, e.code, e.retryable]).toEqual([
			409,
			"agent_outdated",
			false,
		]);
		expect(e.details).toEqual({ capability: "files.archive.v1" });
	});

	it("an unknown agent code → 502 agent_error with details.agentCode", () => {
		const e = agentErrorToHttp(new AgentCallError("quiesced", "frozen"));
		expect([e.status, e.code, e.retryable]).toEqual([
			502,
			"agent_error",
			false,
		]);
		expect(e.details).toEqual({ agentCode: "quiesced" });
		expect(e.message).not.toContain("frozen");
	});

	it("an ApiError passes through; other errors map like toHttpError", () => {
		const api = new ApiError(418, "teapot", "x");
		expect(agentErrorToHttp(api)).toBe(api);
		expect(agentErrorToHttp(new Error("bug")).code).toBe("internal");
		expect(
			agentErrorToHttp(new SbxError("not_found", "no sandbox")).status,
		).toBe(404);
	});
});

describe("agentHttpError", () => {
	function res(
		status: number,
		body: string,
		headers: Record<string, string> = {},
	): Response {
		return new Response(body, { status, headers });
	}

	it("reads the agent's JSON error body", async () => {
		const e = await agentHttpError(
			res(
				404,
				JSON.stringify({
					code: "path_not_found",
					message: "no such file",
					retryable: false,
				}),
				{ "content-type": "application/json" },
			),
		);
		expect(e).toBeInstanceOf(AgentCallError);
		expect(e.code).toBe("path_not_found");
		expect(e.message).toBe("no such file");
		expect(e.status).toBe(404);
	});

	it("takes the offset of upload_offset_mismatch from Sbx-Upload-Offset", async () => {
		const e = await agentHttpError(
			res(
				409,
				JSON.stringify({ code: "upload_offset_mismatch", message: "m" }),
				{ "Sbx-Upload-Offset": "123" },
			),
		);
		expect(e.code).toBe("upload_offset_mismatch");
		expect(e.details).toEqual({ offset: 123 });
		expect(agentErrorToHttp(e).headers).toEqual({ "Sbx-Upload-Offset": "123" });
	});

	it("keeps entries_written of an archive error", async () => {
		const e = await agentHttpError(
			res(
				400,
				JSON.stringify({
					code: "invalid_path",
					message: "m",
					entries_written: 2,
				}),
			),
		);
		expect(e.details).toEqual({ entriesWritten: 2 });
	});

	it("416 without JSON → range_not_satisfiable; other non-JSON → http_<status>", async () => {
		expect((await agentHttpError(res(416, "bad range"))).code).toBe(
			"range_not_satisfiable",
		);
		expect((await agentHttpError(res(500, "<html>"))).code).toBe("http_500");
	});

	it("does not read more than the cap of a huge body", async () => {
		const big = "x".repeat(200_000);
		const e = await agentHttpError(res(500, big));
		expect(e.code).toBe("http_500");
	});
});

describe("files helpers", () => {
	it("filesQuery skips undefined and encodes values", () => {
		expect(
			filesQuery({
				path: "/a b/ä",
				user: undefined,
				overwrite: false,
				offset: 5,
			}),
		).toBe("?path=%2Fa+b%2F%C3%A4&overwrite=false&offset=5");
		expect(filesQuery({})).toBe("");
	});

	it("parses protojson FileInfo, defaults for omitted zero values", () => {
		const info = parseAgentFileInfo({
			path: "/home/user/a.txt",
			name: "a.txt",
			type: "FILE_TYPE_FILE",
			size: "12",
			mode: 420,
			owner: "user",
			group: "user",
			uid: 1000,
			gid: 1000,
			mtime: "2026-10-30T12:00:00.123456789Z",
		});
		expect(info).toEqual({
			path: "/home/user/a.txt",
			name: "a.txt",
			type: "file",
			size: 12,
			mode: 0o644,
			owner: "user",
			group: "user",
			uid: 1000,
			gid: 1000,
			mtime: new Date("2026-10-30T12:00:00.123Z"),
			symlinkTarget: "",
		});
		const dir = parseAgentFileInfo({
			path: "/",
			name: "/",
			type: "FILE_TYPE_DIR",
			mode: 493,
		});
		expect(dir.size).toBe(0);
		expect(dir.uid).toBe(0);
		expect(dir.type).toBe("dir");
		expect(dir.mtime).toBeNull();
	});

	it("agentFileInfoJson is the protojson the agent sends (round trip)", () => {
		const info = {
			path: "/x/l",
			name: "l",
			type: "symlink" as const,
			size: 0,
			mode: 0o777,
			owner: "root",
			group: "root",
			uid: 0,
			gid: 0,
			mtime: new Date("2026-01-02T03:04:05.006Z"),
			symlinkTarget: "/etc",
		};
		const json = agentFileInfoJson(info);
		expect(json).toEqual({
			path: "/x/l",
			name: "l",
			type: "FILE_TYPE_SYMLINK",
			mode: 511,
			owner: "root",
			group: "root",
			mtime: "2026-01-02T03:04:05.006Z",
			symlinkTarget: "/etc",
		});
		expect(parseAgentFileInfo(json)).toEqual(info);
	});
});
