// Helpers for the agent's HTTP `/files*` (S3 §11.2) behind
// `AgentApi.files`: query strings, JSON error bodies and the protojson
// FileInfo the agent answers with.
import { parseUploadOffset, readBodyCapped } from "@sbx/agent-client";
import { AgentCallError } from "./errors.ts";
import type { AgentFileInfo, AgentFileType } from "./types.ts";

/** Cap of an agent JSON body (errors, FileInfo, archive results). */
export const AGENT_JSON_MAX_BYTES = 64 * 1024;

/** `?k=v&...` of the defined values (snake_case names of the agent); "" if none. */
export function filesQuery(
	params: Record<string, string | number | boolean | undefined>,
): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) q.set(k, String(v));
	}
	const s = q.toString();
	return s === "" ? "" : `?${s}`;
}

/** Reads a JSON answer of the agent, at most `maxBytes`. */
export async function readAgentJson(
	res: Response,
	maxBytes = AGENT_JSON_MAX_BYTES,
): Promise<unknown> {
	const body = await readBodyCapped(res, maxBytes);
	return JSON.parse(new TextDecoder().decode(body));
}

/**
 * The AgentCallError of a non-2xx `/files` answer: `{code, message,
 * retryable, entries_written?}` from the body; a body that is not that JSON
 * (or is too large) gives `range_not_satisfiable` for 416, else
 * `http_<status>`. upload_offset_mismatch gets `details.offset` from
 * `Sbx-Upload-Offset`.
 */
export async function agentHttpError(res: Response): Promise<AgentCallError> {
	let body: Record<string, unknown> = {};
	try {
		const v = await readAgentJson(res);
		if (v !== null && typeof v === "object")
			body = v as Record<string, unknown>;
	} catch {
		await res.body?.cancel().catch(() => {});
	}
	const fallback =
		res.status === 416 ? "range_not_satisfiable" : `http_${res.status}`;
	const code =
		typeof body.code === "string" && body.code !== "" ? body.code : fallback;
	const message =
		typeof body.message === "string" && body.message !== ""
			? body.message
			: `the agent answered ${res.status}`;
	const details: Record<string, unknown> = {};
	if (code === "upload_offset_mismatch") {
		const offset = parseUploadOffset(res.headers.get("sbx-upload-offset"));
		if (offset !== undefined) details.offset = Number(offset);
	}
	if (typeof body.entries_written === "number") {
		details.entriesWritten = body.entries_written;
	}
	return new AgentCallError(code, message, details, res.status);
}

const FILE_TYPES: Record<string, AgentFileType> = {
	FILE_TYPE_FILE: "file",
	FILE_TYPE_DIR: "dir",
	FILE_TYPE_SYMLINK: "symlink",
	FILE_TYPE_OTHER: "other",
};

const FILE_TYPE_NAMES: Record<AgentFileType, string> = {
	file: "FILE_TYPE_FILE",
	dir: "FILE_TYPE_DIR",
	symlink: "FILE_TYPE_SYMLINK",
	other: "FILE_TYPE_OTHER",
};

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** uint64 is a string in protojson, uint32 a number; absent is 0. */
function num(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
	return 0;
}

/** FileInfo from its protojson form (zero values may be omitted). */
export function parseAgentFileInfo(json: unknown): AgentFileInfo {
	const o = (json ?? {}) as Record<string, unknown>;
	const mtime = typeof o.mtime === "string" ? new Date(o.mtime) : null;
	return {
		path: str(o.path),
		name: str(o.name),
		type: FILE_TYPES[str(o.type)] ?? "other",
		size: num(o.size),
		mode: num(o.mode),
		owner: str(o.owner),
		group: str(o.group),
		uid: num(o.uid),
		gid: num(o.gid),
		mtime: mtime !== null && !Number.isNaN(mtime.getTime()) ? mtime : null,
		symlinkTarget: str(o.symlinkTarget),
	};
}

/** FileInfo in the agent's protojson form: zero values omitted, uint64 as string. */
export function agentFileInfoJson(
	info: AgentFileInfo,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const set = (k: string, v: unknown, zero: unknown) => {
		if (v !== zero) out[k] = v;
	};
	set("path", info.path, "");
	set("name", info.name, "");
	out.type = FILE_TYPE_NAMES[info.type];
	set("size", info.size === 0 ? 0 : String(info.size), 0);
	set("mode", info.mode, 0);
	set("owner", info.owner, "");
	set("group", info.group, "");
	set("uid", info.uid, 0);
	set("gid", info.gid, 0);
	if (info.mtime !== null) out.mtime = info.mtime.toISOString();
	set("symlinkTarget", info.symlinkTarget, "");
	return out;
}
