// File routes (S7 §11.1). Every call reads the sandbox with the principal,
// waits for ready like commands (§9.1 step 2), touches API activity and
// checks the agent capability (files.v1, files.upload.v1 for uploads,
// files.archive.v1 for archives).
// - Content and archives go through the agent's HTTP `/files*` and are
//   streamed both ways: downloads are piped from the agent, PUT bodies are
//   handed to the agent as the request stream (sent once, never buffered).
// - Upload chunks (up to 8 MiB) are buffered, so agent-client can resend
//   them after a tunnel break. Upload state lives only in the agent: the
//   upload id is a fresh ULID and the api stores nothing.
// - stat, list, mkdir, move, chmod and delete are Filesystem RPCs.
// HEAD requests are routed to the GET handlers by Hono; the HEAD-only
// upload route is a plain GET route documented as HEAD.
import { randomUUID } from "node:crypto";
import { createRoute } from "@hono/zod-openapi";
import type { AgentFetchInit } from "@sbx/agent-client";
import { parseUploadOffset } from "@sbx/agent-client";
import { decodeUlid, newPublicUlid } from "@sbx/auth";
import type { Context } from "hono";
import {
	AgentCallError,
	agentErrorToHttp,
	agentMutationErrorToHttp,
} from "../agent/errors.ts";
import {
	agentHttpError,
	filesQuery,
	parseAgentFileInfo,
	readAgentJson,
} from "../agent/files-http.ts";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import { waitUntilReady } from "../commands/wait-ready.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { incompleteBodyError } from "../http/body-limit.ts";
import {
	decodeCursor,
	encodeCursor,
	invalidCursorError,
} from "../http/cursor.ts";
import {
	ApiError,
	methodNotAllowedError,
	payloadTooLargeError,
} from "../http/errors.ts";
import { toFileInfo } from "../map/file.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import { SandboxParams } from "../schemas/common.ts";
import {
	ArchiveGetQuery,
	ArchivePutQuery,
	ArchiveResultSchema,
	ChmodRequest,
	ChunkQuery,
	CommitUploadRequest,
	ContentQuery,
	CreateUploadRequest,
	ExistedSchema,
	FileInfoSchema,
	FileListSchema,
	ListQuery,
	MakeDirRequest,
	MoveRequest,
	PutContentQuery,
	RemoveQuery,
	StatQuery,
	UPLOAD_CHUNK_BYTES,
	UPLOAD_MAX_CHUNK_BYTES,
	UPLOAD_TTL_MS,
	UploadOffsetSchema,
	UploadParams,
	UploadSchema,
	UserOnlyQuery,
} from "../schemas/files.ts";

const TAGS = ["files"];
const BASE = "/v1/sandboxes/{sandbox}/files";
const OCTET = "application/octet-stream";
const LIST_DEFAULT_LIMIT = 50;

type Capability = "files.v1" | "files.upload.v1" | "files.archive.v1";

const BINARY = { schema: { type: "string" as const, format: "binary" } };

const rawBody = (description: string) => ({
	description,
	required: false,
	content: { [OCTET]: BINARY },
});

const notReady409 =
	"`sandbox_not_ready`, `sandbox_starting` (retryable), `agent_outdated` (details.capability)";

const notFound404 = errorResponse(
	"`not_found` (no such sandbox) or `path_not_found`",
);

const downloadHeaders = {
	"Content-Disposition": {
		description: "`attachment; filename*=UTF-8''<name>`",
		schema: { type: "string" as const },
	},
	"X-Content-Type-Options": {
		schema: { type: "string" as const, enum: ["nosniff"] },
	},
};

const contentHeaders = {
	...downloadHeaders,
	ETag: {
		description: "Strong validator for If-Range",
		schema: { type: "string" as const },
	},
	"Last-Modified": { schema: { type: "string" as const } },
	"Accept-Ranges": { schema: { type: "string" as const, enum: ["bytes"] } },
	"Content-Length": { schema: { type: "integer" as const } },
};

const uploadOffsetHeader = {
	"Sbx-Upload-Offset": {
		description: "Bytes received so far",
		schema: { type: "integer" as const },
	},
};

// --- content ---

const CONTENT_DESCRIPTION =
	"The bytes of a file, streamed from the sandbox. One `Range` (`bytes=a-b`, `a-`, `-n`; " +
	"several ranges give the whole file with 200) and `If-Range` (ETag or date); ETag, " +
	"Last-Modified, Accept-Ranges. Always `application/octet-stream` with " +
	"`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. A directory is " +
	"409 is_directory. In the browser (dashboard origin) `?team=` may replace the Sbx-Team " +
	"header.";

const getContentRoute = createRoute({
	method: "get",
	path: `${BASE}/content`,
	operationId: "files.download",
	summary: "Download a file",
	description: CONTENT_DESCRIPTION,
	tags: TAGS,
	middleware: [requireScope("files:read")] as const,
	request: { params: SandboxParams, query: ContentQuery },
	responses: {
		200: {
			description: "The file",
			headers: contentHeaders,
			content: { [OCTET]: BINARY },
		},
		206: {
			description: "The requested range",
			headers: {
				...contentHeaders,
				"Content-Range": {
					description: "`bytes a-b/size`",
					schema: { type: "string" as const },
				},
			},
			content: { [OCTET]: BINARY },
		},
		404: notFound404,
		409: errorResponse(`\`is_directory\`, ${notReady409}`),
		416: errorResponse(
			"`range_not_satisfiable` (the header `Content-Range: bytes */<size>`)",
		),
		...ERROR_RESPONSES,
	},
});

const putContentRoute = createRoute({
	method: "put",
	path: `${BASE}/content`,
	operationId: "files.write",
	summary: "Write a file",
	description:
		"Writes the request body (any size and content type, streamed) to `path` atomically: " +
		"a temporary file in the same directory, then rename. Not resumable: a broken request " +
		"writes nothing and is repeated whole (the same body gives the same result). For files " +
		"over 64 MiB use the resumable upload (POST .../files/uploads).",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		query: PutContentQuery,
		body: rawBody("The file content"),
	},
	responses: {
		200: jsonResponse(FileInfoSchema, "The written file"),
		404: errorResponse(
			"`not_found` or `path_not_found` (a missing parent with makeParents=false)",
		),
		409: errorResponse(
			`\`is_directory\`, \`already_exists\` (overwrite=false), ${notReady409}`,
		),
		507: errorResponse("`no_space` in the sandbox"),
		...ERROR_RESPONSES,
	},
});

// --- uploads ---

const UPLOADS_FLOW =
	"Flow: POST .../uploads {path} → PUT .../uploads/{upload}?offset=N&path= (chunks up to " +
	"8 MiB, offset = bytes so far) → POST .../uploads/{upload}/commit {path, sha256}. After a " +
	"break, HEAD .../uploads/{upload} gives Sbx-Upload-Offset to resume from. A chunk whose " +
	"offset is not the current size is 409 upload_offset_mismatch with the current offset " +
	"(header Sbx-Upload-Offset, details.offset): continue from there.";

const createUploadRoute = createRoute({
	method: "post",
	path: `${BASE}/uploads`,
	operationId: "files.createUpload",
	summary: "Start a resumable upload",
	description:
		`Starts a resumable upload of a large file. Nothing is stored by the api; the partial ` +
		`file lives in the sandbox and is dropped after 24 h without activity. ${UPLOADS_FLOW}`,
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		body: jsonBody(CreateUploadRequest, "Destination of the file"),
	},
	responses: {
		201: jsonResponse(UploadSchema, "The upload"),
		404: errorResponse("`not_found`"),
		409: errorResponse(notReady409),
		...ERROR_RESPONSES,
	},
});

const putChunkRoute = createRoute({
	method: "put",
	path: `${BASE}/uploads/{upload}`,
	operationId: "files.putChunk",
	summary: "Upload a chunk",
	description:
		"Appends the body (up to 8 MiB, any content type) at `offset`. Send the destination " +
		`as \`path\` too: it tells the sandbox where to keep the partial file. ${UPLOADS_FLOW}`,
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: UploadParams,
		query: ChunkQuery,
		body: rawBody("Bytes of the chunk"),
	},
	responses: {
		200: {
			...jsonResponse(UploadOffsetSchema, "Bytes received so far"),
			headers: uploadOffsetHeader,
		},
		404: errorResponse("`not_found` or `upload_not_found`"),
		409: errorResponse(
			"`upload_offset_mismatch` (details.offset, header Sbx-Upload-Offset), " +
				`\`invalid_state\` (already committed), ${notReady409}`,
		),
		408: errorResponse(
			"`request_timeout` (retryable): no bytes of the chunk arrived for 30 s; " +
				"resume from the offset of HEAD .../uploads/{upload}",
		),
		413: errorResponse("`payload_too_large`: the chunk is over 8 MiB"),
		...ERROR_RESPONSES,
	},
});

const deleteUploadRoute = createRoute({
	method: "delete",
	path: `${BASE}/uploads/{upload}`,
	operationId: "files.deleteUpload",
	summary: "Cancel an upload",
	description:
		"Drops a partial upload. An unknown upload is 404 upload_not_found.",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: { params: UploadParams },
	responses: {
		204: { description: "Cancelled" },
		404: errorResponse("`not_found` or `upload_not_found`"),
		409: errorResponse(notReady409),
		...ERROR_RESPONSES,
	},
});

const commitUploadRoute = createRoute({
	method: "post",
	path: `${BASE}/uploads/{upload}/commit`,
	operationId: "files.commitUpload",
	summary: "Finish an upload",
	description:
		"Moves the uploaded bytes to `path`. Idempotent by upload id: a repeat returns the same " +
		"FileInfo (24 h). A `sha256` that does not match is 422 checksum_mismatch and the upload " +
		`is dropped (start over). ${UPLOADS_FLOW}`,
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: UploadParams,
		query: UserOnlyQuery,
		body: jsonBody(CommitUploadRequest, "Destination and checks"),
	},
	responses: {
		200: jsonResponse(FileInfoSchema, "The file"),
		404: errorResponse("`not_found`, `upload_not_found` or `path_not_found`"),
		409: errorResponse(`\`is_directory\`, \`already_exists\`, ${notReady409}`),
		422: errorResponse("`checksum_mismatch`: the upload was dropped"),
		...ERROR_RESPONSES,
	},
});

// --- filesystem ---

const statRoute = createRoute({
	method: "get",
	path: `${BASE}/stat`,
	operationId: "files.stat",
	summary: "Describe a path",
	description:
		"FileInfo of a path; follows symlinks unless noFollow=true. A missing path is 404 " +
		"path_not_found.",
	tags: TAGS,
	middleware: [requireScope("files:read")] as const,
	request: { params: SandboxParams, query: StatQuery },
	responses: {
		200: jsonResponse(FileInfoSchema, "The path"),
		404: notFound404,
		409: errorResponse(notReady409),
		...ERROR_RESPONSES,
	},
});

const listRoute = createRoute({
	method: "get",
	path: `${BASE}/list`,
	operationId: "files.list",
	summary: "List a directory",
	description:
		"Entries under `path` (down to `depth` levels), ordered by path; symlinks are listed as " +
		"symlinks and not followed. Pages of `limit` (default 50, at most 200); pass nextCursor " +
		"as `cursor` with the same path. A file is 409 not_directory.",
	tags: TAGS,
	middleware: [requireScope("files:read")] as const,
	request: { params: SandboxParams, query: ListQuery },
	responses: {
		200: jsonResponse(FileListSchema, "A page of entries"),
		400: errorResponse("`validation` or `invalid_cursor`"),
		404: notFound404,
		409: errorResponse(`\`not_directory\`, ${notReady409}`),
		...ERROR_RESPONSES,
	},
});

const mkdirRoute = createRoute({
	method: "post",
	path: `${BASE}/mkdir`,
	operationId: "files.mkdir",
	summary: "Create a directory",
	description:
		"Creates a directory (with missing parents when `parents` is true). 201 when created, " +
		"200 when the directory already existed; another file there is 409 already_exists.",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		query: UserOnlyQuery,
		body: jsonBody(MakeDirRequest, "The directory"),
	},
	responses: {
		200: jsonResponse(FileInfoSchema, "The directory already existed"),
		201: jsonResponse(FileInfoSchema, "Created"),
		404: notFound404,
		409: errorResponse(`\`already_exists\`, \`not_directory\`, ${notReady409}`),
		...ERROR_RESPONSES,
	},
});

const moveRoute = createRoute({
	method: "post",
	path: `${BASE}/move`,
	operationId: "files.move",
	summary: "Move or rename",
	description:
		"Renames `from` to `to`. An existing destination is 409 already_exists unless " +
		"overwrite is true. Across filesystems files are copied; directories are 409 " +
		"cross_device.",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		query: UserOnlyQuery,
		body: jsonBody(MoveRequest, "Source and destination"),
	},
	responses: {
		200: jsonResponse(FileInfoSchema, "The destination"),
		404: notFound404,
		409: errorResponse(`\`already_exists\`, \`cross_device\`, ${notReady409}`),
		...ERROR_RESPONSES,
	},
});

const chmodRoute = createRoute({
	method: "post",
	path: `${BASE}/chmod`,
	operationId: "files.chmod",
	summary: "Change mode or owner",
	description:
		"Sets the mode and/or owner and group of a path (recursively when `recursive`; symlinks " +
		"inside are not followed).",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		query: UserOnlyQuery,
		body: jsonBody(ChmodRequest, "What to change"),
	},
	responses: {
		200: jsonResponse(FileInfoSchema, "The path"),
		404: notFound404,
		409: errorResponse(notReady409),
		...ERROR_RESPONSES,
	},
});

const removeRoute = createRoute({
	method: "delete",
	path: BASE,
	operationId: "files.delete",
	summary: "Delete a path",
	description:
		"Removes a file, symlink or directory (a non-empty directory needs recursive=true, " +
		"else 409 invalid_state). A missing path is a success with existed: false.",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: { params: SandboxParams, query: RemoveQuery },
	responses: {
		200: jsonResponse(ExistedSchema, "Removed (or nothing was there)"),
		404: errorResponse("`not_found`"),
		409: errorResponse(`\`invalid_state\` (not empty), ${notReady409}`),
		...ERROR_RESPONSES,
	},
});

// --- archives ---

const getArchiveRoute = createRoute({
	method: "get",
	path: `${BASE}/archive`,
	operationId: "files.downloadArchive",
	summary: "Download a directory as tar",
	description:
		"The directory `path` as one tar stream (POSIX pax; `format=tar.gz` gzips it); names " +
		"are relative to `path`, symlinks are stored as symlinks, sockets, FIFOs and devices " +
		"are skipped. No Range and no resume: an error mid-stream cuts the response without " +
		"the tar end blocks, so the client sees an incomplete archive. Not a directory is 409 " +
		"not_directory.",
	tags: TAGS,
	middleware: [requireScope("files:read")] as const,
	request: { params: SandboxParams, query: ArchiveGetQuery },
	responses: {
		200: {
			description: "The archive",
			headers: downloadHeaders,
			content: { "application/x-tar": BINARY, "application/gzip": BINARY },
		},
		404: notFound404,
		409: errorResponse(`\`not_directory\`, ${notReady409}`),
		...ERROR_RESPONSES,
	},
});

const putArchiveRoute = createRoute({
	method: "put",
	path: `${BASE}/archive`,
	operationId: "files.uploadArchive",
	summary: "Unpack a tar into a directory",
	description:
		"Unpacks the streamed body (tar, or tar.gz with format=tar.gz) into the directory " +
		"`path`. Owner is `user`; uid/gid of the archive are ignored, setuid/setgid dropped. " +
		"Limits: 200 000 entries, 16 GiB of data, 4 096-byte paths, else 413. Absolute paths, " +
		"`..`, hard links out of the archive, devices and FIFOs, and writing through a symlink " +
		"(from the archive or already on disk) are 400 invalid_path. Not atomic: on an error " +
		"what was written stays (details.entriesWritten); unpack into a new directory and move " +
		"it for atomicity. Not resumable: repeat the whole archive (safe with overwrite=true).",
	tags: TAGS,
	middleware: [requireScope("files:write")] as const,
	request: {
		params: SandboxParams,
		query: ArchivePutQuery,
		body: rawBody("The archive"),
	},
	responses: {
		200: jsonResponse(ArchiveResultSchema, "Unpacked"),
		400: errorResponse(
			"`invalid_path` (details.entriesWritten) or `validation` (not a tar stream)",
		),
		404: notFound404,
		409: errorResponse(
			`\`not_directory\`, \`already_exists\` (overwrite=false), ${notReady409}`,
		),
		413: errorResponse("`payload_too_large`: an unpack limit"),
		...ERROR_RESPONSES,
	},
});

// --- helpers ---

/** The machine of a ready sandbox whose agent has the capability. */
async function fileTarget(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	sandbox: string,
	capability: Capability,
): Promise<string> {
	return (await fileSandbox(deps, c, sandbox, capability)).machineId;
}

/** `fileTarget` with the sandbox id. */
async function fileSandbox(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	sandbox: string,
	capability: Capability,
): Promise<{ sandboxId: string; machineId: string }> {
	const p = authOf(c).principal;
	const signal = c.req.raw.signal;
	const s = await waitUntilReady(
		deps,
		p,
		resolveSandboxRef(sandbox),
		signal,
		(s) => deps.svc.touchApiActivity(s.id),
	);
	const { machineId } = await deps.svc.resolveAgentTarget(p, s.id);
	try {
		await deps.agent.requireCapability(machineId, capability, signal);
	} catch (e) {
		throw agentErrorToHttp(e);
	}
	return { sandboxId: s.id, machineId };
}

/** `/files<path>` of the agent; transport failures map to the public errors. */
async function agentFiles(
	deps: ApiDeps,
	machineId: string,
	path: string,
	init: AgentFetchInit,
): Promise<Response> {
	try {
		return await deps.agent.files(machineId, path, init);
	} catch (e) {
		throw agentErrorToHttp(e);
	}
}

/** Throws the public error of a non-2xx agent answer. */
async function ensureOk(res: Response): Promise<void> {
	if (!res.ok) throw agentErrorToHttp(await agentHttpError(res));
}

function badResponse(message: string): ApiError {
	return agentErrorToHttp(new AgentCallError("bad_response", message));
}

/** A non-negative integer field of an agent answer; else 502 agent_error. */
function agentCount(v: unknown, what: string): number {
	const n = typeof v === "string" && /^[0-9]{1,16}$/.test(v) ? Number(v) : v;
	if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
	throw badResponse(`the agent answered without a valid ${what}`);
}

/** The agent's JSON answer; an unreadable one is 502 agent_error. */
async function agentJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const v = await readAgentJson(res);
		if (v !== null && typeof v === "object")
			return v as Record<string, unknown>;
	} catch {
		// reported below
	}
	throw badResponse("the agent answered with invalid JSON");
}

/** RPC call with the agent errors mapped. */
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw agentErrorToHttp(e);
	}
}

/**
 * A mutating Filesystem RPC: its request id is new per request, so a repeat
 * after an unknown outcome would apply it again (503 retryable false,
 * details.outcome "unknown" with `details`).
 */
async function mutation<T>(
	fn: () => Promise<T>,
	what: string,
	details: Record<string, unknown>,
): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw agentMutationErrorToHttp(e, what, details);
	}
}

/** The ULID of `upl_...`; anything else is 404 upload_not_found. */
function uploadIdOf(publicId: string): string {
	const id = decodeUlid("upload", publicId);
	if (id === null) throw uploadNotFoundError();
	return id;
}

function uploadNotFoundError(): ApiError {
	return new ApiError(
		404,
		"upload_not_found",
		"no such upload in this sandbox (expired, cancelled or never started); start a new one",
	);
}

/** Last path component for Content-Disposition; `fallback` for "~", "/" and the like. */
function downloadName(path: string, fallback: string): string {
	const last = path
		.split("/")
		.filter((s) => s !== "" && s !== ".")
		.at(-1);
	return last === undefined || last === "~" || last === ".." ? fallback : last;
}

/** `attachment; filename*=UTF-8''<name>` (RFC 6266, RFC 8187 encoding). */
function attachment(name: string): string {
	const enc = encodeURIComponent(name).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename*=UTF-8''${enc}`;
}

const PASSED_CONTENT_HEADERS = [
	"Content-Length",
	"Content-Range",
	"ETag",
	"Last-Modified",
	"Accept-Ranges",
];

/** The request body, at most UPLOAD_MAX_CHUNK_BYTES (else 413). */
async function readChunk(req: Request): Promise<Uint8Array<ArrayBuffer>> {
	if (req.body === null) return new Uint8Array();
	const reader = req.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		let r: ReadableStreamReadResult<Uint8Array>;
		try {
			r = await reader.read();
		} catch {
			throw incompleteBodyError();
		}
		if (r.done) break;
		size += r.value.byteLength;
		if (size > UPLOAD_MAX_CHUNK_BYTES) {
			await reader.cancel().catch(() => {});
			throw payloadTooLargeError(UPLOAD_MAX_CHUNK_BYTES);
		}
		parts.push(r.value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.byteLength;
	}
	return out;
}

/** `true`/`false` of a boolean query, undefined when absent. */
function flag(v: "true" | "false" | undefined): boolean | undefined {
	return v === undefined ? undefined : v === "true";
}

/** What a files/list cursor is bound to: the same listing, page after page. */
interface ListScope {
	sandboxId: string;
	path: string;
	depth: number;
	includeHidden: boolean;
}

/** Inner value of a files/list cursor: the agent page_token and its listing. */
function listCursor(scope: ListScope, token: string): string {
	return JSON.stringify({
		s: scope.sandboxId,
		p: scope.path,
		d: scope.depth,
		h: scope.includeHidden,
		t: token,
	});
}

/** The page_token of a verified cursor; 400 invalid_cursor unless it is of this listing. */
function listToken(inner: string, scope: ListScope): string {
	try {
		const v = JSON.parse(inner) as Record<string, unknown>;
		if (
			v.s === scope.sandboxId &&
			v.p === scope.path &&
			v.d === scope.depth &&
			v.h === scope.includeHidden &&
			typeof v.t === "string"
		) {
			return v.t;
		}
	} catch {
		// reported below
	}
	throw invalidCursorError();
}

// --- registration ---

export function registerFileRoutes(app: ApiApp, deps: ApiDeps): void {
	// GET and HEAD (Hono routes HEAD to this handler).
	app.openapi(getContentRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const head = c.req.raw.method === "HEAD";
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const headers: Record<string, string> = {};
		for (const name of ["range", "if-range"]) {
			const v = c.req.header(name);
			if (v !== undefined) headers[name] = v;
		}
		const path = filesQuery({ path: q.path, user: q.user });
		const init: AgentFetchInit = {
			method: head ? "HEAD" : "GET",
			headers,
			signal: c.req.raw.signal,
		};
		const res = await agentFiles(deps, m, path, init);
		if (!res.ok) {
			let e = await agentHttpError(res);
			if (head && e.code === `http_${res.status}`) {
				// A HEAD answer has no body: ask with GET for the error code.
				const again = await agentFiles(deps, m, path, {
					...init,
					method: "GET",
				});
				if (!again.ok) e = await agentHttpError(again);
				else await again.body?.cancel().catch(() => {});
			}
			const api = agentErrorToHttp(e);
			const range = res.headers.get("content-range");
			if (api.status === 416 && range !== null) {
				throw new ApiError(api.status, api.code, api.message, {
					details: api.details,
					headers: { ...api.headers, "Content-Range": range },
				});
			}
			throw api;
		}
		const out: Record<string, string> = {
			"Content-Type": OCTET,
			"Content-Disposition": attachment(downloadName(q.path, "file")),
			"X-Content-Type-Options": "nosniff",
		};
		for (const name of PASSED_CONTENT_HEADERS) {
			const v = res.headers.get(name);
			if (v !== null) out[name] = v;
		}
		// Only the documented statuses pass; any other 2xx is not a download.
		if (res.status !== 200 && res.status !== 206) {
			await res.body?.cancel().catch(() => {});
			throw badResponse(`the agent answered ${res.status} to a download`);
		}
		const status = res.status;
		if (head || res.body === null) {
			await res.body?.cancel().catch(() => {});
			return c.body(null, status, out) as never;
		}
		return c.body(res.body, status, out) as never;
	});
	app.openAPIRegistry.registerPath({
		method: "head",
		path: `${BASE}/content`,
		operationId: "files.downloadHead",
		summary: "File headers",
		description:
			"The headers of GET .../files/content (size in Content-Length, ETag, Last-Modified) " +
			"without the body. Errors have no body either: see the status.",
		tags: TAGS,
		request: { params: SandboxParams, query: ContentQuery },
		responses: {
			200: { description: "The file exists", headers: contentHeaders },
			404: { description: "No such sandbox or path" },
			409: { description: "A directory, or the sandbox is not ready" },
			...ERROR_RESPONSES,
		},
	});

	app.openapi(putContentRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const res = await agentFiles(
			deps,
			m,
			filesQuery({
				path: q.path,
				user: q.user,
				mode: q.mode,
				make_parents: flag(q.makeParents),
				overwrite: flag(q.overwrite),
			}),
			{
				method: "PUT",
				headers: { "content-type": OCTET },
				// The request stream itself: sent once, never buffered here.
				body: c.req.raw.body ?? new Uint8Array(),
				signal: c.req.raw.signal,
			},
		);
		await ensureOk(res);
		return c.json(toFileInfo(parseAgentFileInfo(await agentJson(res))), 200);
	});

	app.openapi(createUploadRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		await fileTarget(deps, c, sandbox, "files.upload.v1");
		return c.json(
			{
				uploadId: newPublicUlid("upload"),
				chunkSizeBytes: UPLOAD_CHUNK_BYTES,
				maxChunkSizeBytes: UPLOAD_MAX_CHUNK_BYTES,
				expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
			},
			201,
		);
	});

	app.openapi(putChunkRoute, async (c) => {
		const params = c.req.valid("param");
		const q = c.req.valid("query");
		const m = await fileTarget(deps, c, params.sandbox, "files.upload.v1");
		const id = uploadIdOf(params.upload);
		// Buffered (<= 8 MiB) so that agent-client may resend it.
		const data = await readChunk(c.req.raw);
		const res = await agentFiles(
			deps,
			m,
			`/uploads/${id}${filesQuery({ offset: q.offset, path: q.path, user: q.user })}`,
			{
				method: "PUT",
				headers: { "content-type": OCTET },
				body: data,
				signal: c.req.raw.signal,
			},
		);
		await ensureOk(res);
		const header = parseUploadOffset(res.headers.get("sbx-upload-offset"));
		const offset =
			header === undefined
				? agentCount((await agentJson(res)).offset, "offset")
				: Number(header);
		if (header !== undefined) await res.body?.cancel().catch(() => {});
		return c.json({ offset }, 200, { "Sbx-Upload-Offset": String(offset) });
	});

	// HEAD .../uploads/{upload}: Hono routes HEAD to GET handlers.
	app.get(
		"/v1/sandboxes/:sandbox/files/uploads/:upload",
		requireScope("files:write"),
		async (c) => {
			if (c.req.raw.method !== "HEAD") {
				throw methodNotAllowedError(["HEAD", "PUT", "DELETE"]);
			}
			const m = await fileTarget(
				deps,
				c,
				c.req.param("sandbox"),
				"files.upload.v1",
			);
			const id = uploadIdOf(c.req.param("upload"));
			const res = await agentFiles(deps, m, `/uploads/${id}`, {
				method: "HEAD",
				signal: c.req.raw.signal,
			});
			if (res.status === 404) throw uploadNotFoundError();
			await ensureOk(res);
			const offset = parseUploadOffset(res.headers.get("sbx-upload-offset"));
			if (offset === undefined) {
				throw badResponse("the agent sent no Sbx-Upload-Offset");
			}
			return c.body(null, 200, { "Sbx-Upload-Offset": String(offset) });
		},
	);
	app.openAPIRegistry.registerPath({
		method: "head",
		path: `${BASE}/uploads/{upload}`,
		operationId: "files.uploadOffset",
		summary: "Offset of an upload",
		description:
			`Sbx-Upload-Offset: the bytes received so far, where the next chunk starts. 404 ` +
			`when the upload does not exist (expired, cancelled, committed with a bad checksum, ` +
			`or no chunk yet). ${UPLOADS_FLOW}`,
		tags: TAGS,
		request: { params: UploadParams },
		responses: {
			200: { description: "The upload exists", headers: uploadOffsetHeader },
			404: { description: "No such sandbox or upload" },
			409: {
				description:
					"The sandbox is not ready, or the agent lacks files.upload.v1 (agent_outdated)",
			},
			...ERROR_RESPONSES,
		},
	});

	app.openapi(deleteUploadRoute, async (c) => {
		const params = c.req.valid("param");
		const m = await fileTarget(deps, c, params.sandbox, "files.upload.v1");
		const id = uploadIdOf(params.upload);
		const res = await agentFiles(deps, m, `/uploads/${id}`, {
			method: "DELETE",
			signal: c.req.raw.signal,
		});
		await ensureOk(res);
		await res.body?.cancel().catch(() => {});
		return c.body(null, 204);
	});

	app.openapi(commitUploadRoute, async (c) => {
		const params = c.req.valid("param");
		const q = c.req.valid("query");
		const b = c.req.valid("json");
		const m = await fileTarget(deps, c, params.sandbox, "files.upload.v1");
		const id = uploadIdOf(params.upload);
		const body: Record<string, unknown> = { path: b.path };
		if (b.sha256 !== undefined) body.sha256 = b.sha256.toLowerCase();
		if (b.mode !== undefined) body.mode = b.mode;
		if (b.owner !== undefined) body.owner = b.owner;
		if (b.overwrite !== undefined) body.overwrite = b.overwrite;
		if (b.makeParents !== undefined) body.make_parents = b.makeParents;
		const res = await agentFiles(
			deps,
			m,
			`/uploads/${id}/commit${filesQuery({ user: q.user })}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: c.req.raw.signal,
			},
		);
		await ensureOk(res);
		return c.json(toFileInfo(parseAgentFileInfo(await agentJson(res))), 200);
	});

	app.openapi(statRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const info = await rpc(() =>
			deps.agent.stat(m, {
				path: q.path,
				...(q.user === undefined ? {} : { user: q.user }),
				noFollow: q.noFollow === "true",
			}),
		);
		return c.json(toFileInfo(info), 200);
	});

	app.openapi(listRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const key = deps.settings.cursorKey;
		// The signature first: a forged cursor is 400 whatever the sandbox state.
		const inner =
			q.cursor === undefined ? undefined : decodeCursor(q.cursor, key);
		const { sandboxId, machineId: m } = await fileSandbox(
			deps,
			c,
			sandbox,
			"files.v1",
		);
		const scope: ListScope = {
			sandboxId,
			path: q.path,
			depth: q.depth ?? 1,
			includeHidden: q.includeHidden !== "false",
		};
		const pageToken = inner === undefined ? undefined : listToken(inner, scope);
		const r = await rpc(() =>
			deps.agent.list(m, {
				path: q.path,
				...(q.user === undefined ? {} : { user: q.user }),
				depth: scope.depth,
				includeHidden: scope.includeHidden,
				pageSize: q.limit ?? LIST_DEFAULT_LIMIT,
				...(pageToken === undefined ? {} : { pageToken }),
			}),
		);
		return c.json(
			{
				data: r.entries.map(toFileInfo),
				nextCursor:
					r.nextPageToken === ""
						? null
						: encodeCursor(listCursor(scope, r.nextPageToken), key),
			},
			200,
		);
	});

	app.openapi(mkdirRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const b = c.req.valid("json");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const r = await mutation(
			() =>
				deps.agent.makeDir(m, {
					path: b.path,
					...(q.user === undefined ? {} : { user: q.user }),
					parents: b.parents ?? false,
					...(b.mode === undefined ? {} : { mode: b.mode }),
					requestId: randomUUID(),
				}),
			"the directory may have been created",
			{ path: b.path },
		);
		return c.json(toFileInfo(r.info), r.created ? 201 : 200);
	});

	app.openapi(moveRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const b = c.req.valid("json");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const info = await mutation(
			() =>
				deps.agent.move(m, {
					src: b.from,
					dst: b.to,
					...(q.user === undefined ? {} : { user: q.user }),
					overwrite: b.overwrite ?? false,
					requestId: randomUUID(),
				}),
			"the path may have been moved",
			{ path: b.from, to: b.to },
		);
		return c.json(toFileInfo(info), 200);
	});

	app.openapi(chmodRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const b = c.req.valid("json");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const info = await mutation(
			() =>
				deps.agent.chmod(m, {
					path: b.path,
					...(q.user === undefined ? {} : { user: q.user }),
					...(b.mode === undefined ? {} : { mode: b.mode }),
					...(b.owner === undefined ? {} : { owner: b.owner }),
					...(b.group === undefined ? {} : { group: b.group }),
					recursive: b.recursive ?? false,
					requestId: randomUUID(),
				}),
			"the mode or owner may have been changed",
			{ path: b.path },
		);
		return c.json(toFileInfo(info), 200);
	});

	app.openapi(removeRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const m = await fileTarget(deps, c, sandbox, "files.v1");
		const r = await mutation(
			() =>
				deps.agent.remove(m, {
					path: q.path,
					...(q.user === undefined ? {} : { user: q.user }),
					recursive: q.recursive === "true",
					requestId: randomUUID(),
				}),
			"the path may have been deleted",
			{ path: q.path },
		);
		return c.json({ existed: r.existed }, 200);
	});

	app.openapi(getArchiveRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const format = q.format ?? "tar";
		const m = await fileTarget(deps, c, sandbox, "files.archive.v1");
		const headers = {
			"Content-Type":
				format === "tar" ? "application/x-tar" : "application/gzip",
			"Content-Disposition": attachment(
				`${downloadName(q.path, "archive")}.${format}`,
			),
			"X-Content-Type-Options": "nosniff",
		};
		if (c.req.raw.method === "HEAD") {
			// No tar is started for HEAD: the headers, after a Stat that gives
			// the same path_not_found / not_directory answers as GET.
			const info = await rpc(() =>
				deps.agent.stat(m, {
					path: q.path,
					...(q.user === undefined ? {} : { user: q.user }),
				}),
			);
			if (info.type !== "dir") {
				throw new ApiError(
					409,
					"not_directory",
					`${info.path} is not a directory`,
				);
			}
			return c.body(null, 200, headers) as never;
		}
		const res = await agentFiles(
			deps,
			m,
			`/archive${filesQuery({ path: q.path, user: q.user, format })}`,
			{ method: "GET", signal: c.req.raw.signal },
		);
		await ensureOk(res);
		if (res.body === null) throw badResponse("the agent sent no archive");
		return c.body(res.body, 200, headers) as never;
	});

	app.openapi(putArchiveRoute, async (c) => {
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const m = await fileTarget(deps, c, sandbox, "files.archive.v1");
		const res = await agentFiles(
			deps,
			m,
			`/archive${filesQuery({
				path: q.path,
				user: q.user,
				format: q.format ?? "tar",
				overwrite: flag(q.overwrite),
				make_parents: flag(q.makeParents),
			})}`,
			{
				method: "PUT",
				headers: { "content-type": OCTET },
				// The request stream itself: sent once, never buffered here.
				body: c.req.raw.body ?? new Uint8Array(),
				signal: c.req.raw.signal,
			},
		);
		await ensureOk(res);
		const r = await agentJson(res);
		if (typeof r.path !== "string" || r.path === "") {
			throw badResponse("the agent answered without the archive path");
		}
		return c.json(
			{
				path: r.path,
				entries: agentCount(r.entries, "entry count"),
				sizeBytes: agentCount(r.size, "size"),
			},
			200,
		);
	});
}
