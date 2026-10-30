// File tools (S11 8.4, 9.2, 9.3, 11.3): files_read, files_write, files_edit,
// files_list, files_stat, files_delete. Files are read as bytes with `Range`
// and decoded here, so every offset given to the model is a byte offset on a
// character boundary. Names and text from the sandbox appear only inside a
// fence, or sanitized when they must be in the JSON header.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type FileInfo, SbxError } from "@sbx/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { fenceUntrusted } from "../output/fence.ts";
import { IMAGE_MAX_BYTES, sniffImage } from "../output/image.ts";
import { toolText } from "../output/result.ts";
import { sanitizeForLlm } from "../output/sanitize.ts";
import { decodeWindow, type Window } from "../output/utf8.ts";
import { defineTool } from "../registry.ts";
import { compact } from "./view.ts";

export { IMAGE_MAX_BYTES } from "../output/image.ts";

/** files_write and files_edit handle at most this many bytes (S11 9.2). */
export const WRITE_MAX_BYTES = 1024 * 1024;

const FILES_PATH = "/v1/sandboxes/{sandbox}/files";
const DEFAULT_READ_BYTES = 32_768;
const MAX_READ_BYTES = 65_536;
/** Below this a window could hold nothing but a split character. */
const MIN_READ_BYTES = 1_024;
/**
 * A base64 window is at most this many bytes: base64 is 4/3 of them and a
 * response holds at most 80 000 characters (S11 9.2).
 */
const BASE64_WINDOW_BYTES = 49_152;
/**
 * Sanitizing can write one byte as up to 9 characters, so a text window is
 * shortened until its sanitized text fits this many characters (the header
 * and notes come on top of it, under the 80 000 of the whole response).
 */
const TEXT_CHARS_BUDGET = 70_000;
/** The binary check and the image sniff look at this much of the head. */
const SNIFF_BYTES = 8_192;
const LIST_MAX = 200;
const CONTEXT_LINES = 5;
const MAX_OFFSET = 2 ** 48;

/** Fence labels are constants: nothing from the sandbox goes into them. */
const LABEL_FILE = "kind=file";
const LABEL_BASE64 = "kind=file encoding=base64";
const LABEL_LISTING = "kind=listing";
const LABEL_CONTEXT = "kind=context";
const LABEL_STAT = "kind=stat";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const REPEATABLE_DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

// Field descriptions are terse: tools/list has a budget (S11 7.1).
const pathShape = z
	.string()
	.min(1)
	.describe("Absolute, or relative to the user's home");
const userShape = z
	.string()
	.optional()
	.describe("Guest user (default: login user)");

const SIZE_HINT =
	"for larger files and directories ask the human to run `sbx cp` or `sbx push` in a terminal.";

function tooLarge(what: string, bytes: number): ToolError {
	return new ToolError({
		code: "payload_too_large",
		message: `${what} is ${bytes} bytes; the limit is 1 MiB`,
		hint: SIZE_HINT,
	});
}

function validation(message: string, hint?: string): ToolError {
	return new ToolError({
		code: "validation",
		message,
		...(hint === undefined ? {} : { hint }),
	});
}

/** `0644` for 420; the API gives the permission bits as a number. */
function octalMode(mode: number): string {
	return mode.toString(8).padStart(4, "0");
}

/** The sandbox's time in the same form everywhere: ISO 8601 UTC. */
function isoOf(header: string | null): string | undefined {
	if (header === null) return undefined;
	const t = Date.parse(header);
	return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function bytesOf(data: unknown): Uint8Array {
	return new Uint8Array((data as ArrayBuffer | undefined) ?? []);
}

/** Bytes `[start, start + bytes.length)` of a file of `size` bytes. */
interface Part {
	bytes: Uint8Array;
	start: number;
	size: number;
	modifiedAt?: string;
}

interface FileRef {
	sandbox: string;
	path: string;
	user: string | undefined;
}

/**
 * `GET /files/content` with `Range: bytes=start-(start+length-1)`. An API
 * that ignores the range (200) is handled: the part is cut from the body. A
 * start at or past the end is a 416 SbxError (the real API sends the size
 * only in a header the SDK drops): see `readWindow`.
 */
async function readRange(
	ctx: ToolContext,
	f: FileRef,
	start: number,
	length: number,
): Promise<Part> {
	{
		const { data, response } = await ctx
			.sbx()
			.raw.GET(`${FILES_PATH}/content`, {
				params: {
					path: { sandbox: f.sandbox },
					query: { path: f.path, ...compact({ user: f.user }) },
				},
				headers: { Range: `bytes=${start}-${start + length - 1}` },
				parseAs: "arrayBuffer",
				...ctx.call,
			});
		const body = bytesOf(data);
		const modifiedAt = isoOf(response.headers.get("Last-Modified"));
		const extra = modifiedAt === undefined ? {} : { modifiedAt };
		if (response.status !== 206) {
			return {
				bytes: body.subarray(start, start + length),
				start: Math.min(start, body.length),
				size: body.length,
				...extra,
			};
		}
		const total = /\/(\d+)\s*$/.exec(
			response.headers.get("Content-Range") ?? "",
		);
		return {
			bytes: body,
			start,
			size: total === null ? start + body.length : Number(total[1]),
			...extra,
		};
	}
}

/**
 * `readRange`, but a start at or past the end (416) is an empty part: the
 * size comes from a stat, so offset == size is eof and offset > size is
 * reported by `checkOffset`.
 */
async function readWindow(
	ctx: ToolContext,
	f: FileRef,
	start: number,
	length: number,
): Promise<Part> {
	try {
		return await readRange(ctx, f, start, length);
	} catch (err) {
		if (!(err instanceof SbxError) || err.status !== 416) throw err;
		const info = await ctx
			.sbx()
			.sandboxes.handle(f.sandbox)
			.files.stat(f.path, { ...compact({ user: f.user }), ...ctx.call });
		const modifiedAt = info.modifiedAt ?? undefined;
		return {
			bytes: new Uint8Array(),
			start,
			size: info.sizeBytes,
			...(modifiedAt === undefined ? {} : { modifiedAt }),
		};
	}
}

function windowHeader(f: FileRef, from: number, to: number, part: Part) {
	const eof = to >= part.size;
	return {
		path: f.path,
		size: part.size,
		range: { from, to },
		modified_at: part.modifiedAt,
		...(eof ? { eof: true } : { next_offset: to }),
	};
}

function continueNote(to: number, size: number, extra = ""): string[] {
	if (to >= size) return [];
	return [
		`bytes up to ${to} of ${size}. Continue: files_read with offset=${to}${extra}.`,
	];
}

/** Offset checks shared by the text and base64 windows. */
function checkOffset(offset: number, part: Part): void {
	if (offset > part.size) {
		throw validation(
			`offset ${offset} is past the end of the file (${part.size} bytes)`,
			"use an offset below the size, or omit it.",
		);
	}
}

/**
 * Decodes a text window, shortened (on a character boundary) until its
 * sanitized text fits TEXT_CHARS_BUDGET, so `to` is what the model gets.
 */
function fittingWindow(part: Part): Window {
	let n = part.bytes.length;
	for (;;) {
		const w = decodeWindow(part.bytes.subarray(0, n), part.start, part.size, {
			atStart: part.start === 0,
			final: part.start + n >= part.size,
		});
		const chars = sanitizeForLlm(w.text).length;
		if (chars <= TEXT_CHARS_BUDGET) return w;
		// Proportional, with a margin; always shorter than before.
		n = Math.min(n - 1, Math.floor((n * TEXT_CHARS_BUDGET * 0.9) / chars));
	}
}

function textAnswer(f: FileRef, part: Part, offset: number): CallToolResult {
	checkOffset(offset, part);
	const w = fittingWindow(part);
	const notes = continueNote(w.to, part.size);
	return toolText(windowHeader(f, w.from, w.to, part), [
		...(notes.length > 0 ? [notes.join("\n")] : []),
		...(w.text === ""
			? []
			: [fenceUntrusted([{ label: LABEL_FILE, text: w.text }])]),
	]);
}

function base64Answer(f: FileRef, part: Part, offset: number): CallToolResult {
	checkOffset(offset, part);
	const to = part.start + part.bytes.length;
	const notes = continueNote(
		to,
		part.size,
		`, at most ${BASE64_WINDOW_BYTES} bytes per call as base64`,
	);
	return toolText(
		{
			...windowHeader(f, part.start, to, part),
			encoding: "base64",
		},
		[
			...(notes.length > 0 ? [notes.join("\n")] : []),
			...(part.bytes.length === 0
				? []
				: [
						fenceUntrusted([
							{
								label: LABEL_BASE64,
								text: Buffer.from(part.bytes).toString("base64"),
							},
						]),
					]),
		],
	);
}

function binaryAnswer(f: FileRef, part: Part): CallToolResult {
	return toolText(
		{
			path: f.path,
			size: part.size,
			modified_at: part.modifiedAt,
			binary: true,
		},
		[
			"binary file (NUL bytes in the first 8 KiB): no content returned. Read the raw bytes with as: base64 (offset, max_bytes), or process the file with exec_run.",
		],
	);
}

async function imageAnswer(
	ctx: ToolContext,
	f: FileRef,
	head: Part,
	mime: string,
): Promise<CallToolResult> {
	let bytes = head.bytes;
	if (head.bytes.length < head.size) {
		const rest = await readRange(
			ctx,
			f,
			head.bytes.length,
			head.size - head.bytes.length,
		);
		bytes = new Uint8Array(head.bytes.length + rest.bytes.length);
		bytes.set(head.bytes, 0);
		bytes.set(rest.bytes, head.bytes.length);
	}
	const header = toolText({
		path: f.path,
		size: head.size,
		mime_type: mime,
		modified_at: head.modifiedAt,
	});
	return {
		content: [
			...header.content,
			{
				type: "image",
				data: Buffer.from(bytes).toString("base64"),
				mimeType: mime,
			},
		],
	};
}

export const filesRead = defineTool({
	name: "files_read",
	title: "Read a file",
	description:
		"Reads a file. Text comes back as a window of max_bytes from offset; continue with next_offset until eof. PNG, JPEG, GIF and WebP up to 3 MiB come back as an image. Binary files return no content: use as=base64.",
	toolset: "files",
	scopes: ["files:read"],
	annotations: READ_ONLY,
	sandboxArg: true,
	shape: {
		path: pathShape,
		offset: z
			.number()
			.int()
			.min(0)
			.max(MAX_OFFSET)
			.optional()
			.describe("Byte offset (default 0); next_offset of the last answer"),
		max_bytes: z
			.number()
			.int()
			.min(MIN_READ_BYTES)
			.max(MAX_READ_BYTES)
			.optional()
			.describe(
				`Window size (default ${DEFAULT_READ_BYTES}; base64: at most ${BASE64_WINDOW_BYTES})`,
			),
		as: z
			.enum(["auto", "text", "base64", "image"])
			.optional()
			.describe("auto (default): image, text or binary notice"),
		user: userShape,
	},
	async handler(args, ctx) {
		const f: FileRef = {
			sandbox: args.sandbox,
			path: args.path,
			user: args.user,
		};
		const as = args.as ?? "auto";
		const offset = args.offset ?? 0;
		const max = args.max_bytes ?? DEFAULT_READ_BYTES;

		if (as === "text") {
			return textAnswer(f, await readWindow(ctx, f, offset, max), offset);
		}
		if (as === "base64") {
			const window = Math.min(max, BASE64_WINDOW_BYTES);
			return base64Answer(f, await readWindow(ctx, f, offset, window), offset);
		}

		// auto and image look at the head of the file. At offset 0 the same
		// request is the first text window; later windows cost one more request.
		const first =
			as === "auto" && offset === 0 ? Math.max(max, SNIFF_BYTES) : SNIFF_BYTES;
		const head = await readWindow(ctx, f, 0, first);
		const mime = sniffImage(head.bytes);
		if (mime !== null && head.size <= IMAGE_MAX_BYTES) {
			return imageAnswer(ctx, f, head, mime);
		}
		if (as === "image") {
			if (mime === null) {
				throw validation(
					"the file is not a PNG, JPEG, GIF or WebP image",
					"use as: auto or text for text, as: base64 for other bytes.",
				);
			}
			throw new ToolError({
				code: "payload_too_large",
				message: `the image is ${head.size} bytes; images are limited to 3 MiB`,
				hint: "make it smaller in the sandbox (for example resize or recompress it with exec_run), then read it again.",
			});
		}
		// An image too large to return is binary even without a NUL in its head.
		if (mime !== null || head.bytes.subarray(0, SNIFF_BYTES).includes(0)) {
			return binaryAnswer(f, head);
		}
		if (offset === 0) {
			return textAnswer(
				f,
				{ ...head, bytes: head.bytes.subarray(0, max) },
				offset,
			);
		}
		// The head says how long the file is: no request for a start past its end.
		if (offset >= head.size) {
			return textAnswer(
				f,
				{ ...head, bytes: new Uint8Array(), start: offset },
				offset,
			);
		}
		return textAnswer(f, await readRange(ctx, f, offset, max), offset);
	},
});

function decodeContent(
	content: string,
	encoding: "utf8" | "base64",
): Uint8Array {
	if (encoding === "utf8") {
		const n = Buffer.byteLength(content, "utf8");
		if (n > WRITE_MAX_BYTES) throw tooLarge("content", n);
		return Buffer.from(content, "utf8");
	}
	const clean = content.replace(/\s+/g, "");
	if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
		throw validation(
			"content is not valid base64",
			"encode the bytes as standard base64 with padding, or use encoding: utf8 for text.",
		);
	}
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	const n = (clean.length / 4) * 3 - padding;
	if (n > WRITE_MAX_BYTES) throw tooLarge("content", n);
	return Buffer.from(clean, "base64");
}

export const filesWrite = defineTool({
	name: "files_write",
	title: "Write a file",
	description:
		"Writes a file atomically; creates parent directories and replaces an existing file by default. Up to 1 MiB: for larger files and directories ask the human to run sbx cp or sbx push in a terminal. mode is octal, e.g. 0644.",
	toolset: "files",
	scopes: ["files:write"],
	annotations: REPEATABLE_DESTRUCTIVE,
	sandboxArg: true,
	shape: {
		path: pathShape,
		content: z.string().describe("File content, up to 1 MiB after decoding"),
		encoding: z
			.enum(["utf8", "base64"])
			.optional()
			.describe("Encoding of content (default utf8)"),
		mode: z
			.string()
			.regex(/^[0-7]{3,4}$/)
			.optional()
			.describe("Octal permissions, e.g. 0644 (default: system's)"),
		make_parents: z
			.boolean()
			.optional()
			.describe("Create parent directories (default true)"),
		overwrite: z
			.boolean()
			.optional()
			.describe("Replace an existing file (default true)"),
		user: userShape,
	},
	async handler(args, ctx) {
		// Checked before the API: a big body never travels through the model's context.
		const bytes = decodeContent(args.content, args.encoding ?? "utf8");
		const info = await ctx
			.sbx()
			.sandboxes.handle(args.sandbox)
			.files.writeBytes(args.path, bytes, {
				...(args.mode === undefined
					? {}
					: { mode: Number.parseInt(args.mode, 8) }),
				...(args.make_parents === undefined
					? {}
					: { makeParents: args.make_parents }),
				...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
				...compact({ user: args.user }),
				...ctx.call,
			});
		return toolText({
			path: args.path,
			size: info.sizeBytes,
			mode: octalMode(info.mode),
			modified_at: info.modifiedAt,
		});
	},
});

const NO_MATCH_HINT =
	"read the file with files_read and copy the text exactly, whitespace and line endings included (CRLF is not converted).";

function countMatches(text: string, needle: string): number {
	let n = 0;
	for (
		let i = text.indexOf(needle);
		i !== -1;
		i = text.indexOf(needle, i + needle.length)
	) {
		n++;
	}
	return n;
}

function lineCount(text: string): number {
	const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return Math.max(1, lines);
}

/**
 * Up to CONTEXT_LINES lines of the new text around the first replacement
 * (`first` is its index, the text before it is unchanged).
 */
function contextAround(
	text: string,
	first: number,
	replacement: string,
): { from: number; lines: string } {
	const lines = text.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const at = text.slice(0, first).split("\n").length - 1;
	const span = lineCount(replacement);
	const wanted = Math.max(0, Math.floor((CONTEXT_LINES - span) / 2));
	const end = Math.min(lines.length, Math.max(0, at - wanted) + CONTEXT_LINES);
	const start = Math.max(0, Math.min(at - wanted, end - CONTEXT_LINES));
	return { from: start + 1, lines: lines.slice(start, end).join("\n") };
}

export const filesEdit = defineTool({
	name: "files_edit",
	title: "Edit a file",
	description:
		"Replaces old_text with new_text in a UTF-8 file up to 1 MiB. old_text must occur exactly once, byte for byte with line endings, unless replace_all is set. Fails with conflict if the file changed meanwhile.",
	toolset: "files",
	scopes: ["files:read", "files:write"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: {
		path: pathShape,
		old_text: z
			.string()
			.min(1)
			.describe("Text to replace, exactly as in the file"),
		new_text: z.string().describe("Replacement (may be empty)"),
		replace_all: z
			.boolean()
			.optional()
			.describe("Replace every match (default false)"),
		user: userShape,
	},
	async handler(args, ctx) {
		if (args.old_text === args.new_text) {
			throw validation(
				"old_text and new_text are identical; nothing to change",
			);
		}
		const files = ctx.sbx().sandboxes.handle(args.sandbox).files;
		const o = () => ({ ...compact({ user: args.user }), ...ctx.call });

		// 1. A regular UTF-8 text file up to 1 MiB, read whole.
		const before = await files.stat(args.path, o());
		if (before.type !== "file") {
			throw validation(
				`${args.path} is not a regular file (it is a ${before.type})`,
			);
		}
		if (before.sizeBytes > WRITE_MAX_BYTES)
			throw tooLarge("the file", before.sizeBytes);
		const bytes = await files.readBytes(args.path, o());
		if (bytes.length !== before.sizeBytes) throw changedError();
		if (bytes.includes(0)) {
			throw validation(
				"the file is binary (it contains NUL bytes)",
				"files_edit changes text files only; use exec_run to change a binary file.",
			);
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes,
			);
		} catch {
			throw validation(
				"the file is not valid UTF-8",
				"files_edit changes UTF-8 text files only; use exec_run to change other files.",
			);
		}

		// 2. Byte-exact match: the line endings are not normalized.
		const matches = countMatches(text, args.old_text);
		if (matches === 0) {
			throw new ToolError({
				code: "old_text_not_found",
				message: `old_text not found in ${args.path}`,
				hint: NO_MATCH_HINT,
			});
		}
		const all = args.replace_all === true;
		if (matches > 1 && !all) {
			throw new ToolError({
				code: "ambiguous_match",
				message: `old_text matches ${matches} times, add more context or set replace_all`,
			});
		}
		const first = text.indexOf(args.old_text);
		const next = all
			? text.split(args.old_text).join(args.new_text)
			: text.slice(0, first) +
				args.new_text +
				text.slice(first + args.old_text.length);
		const out = Buffer.from(next, "utf8");
		if (out.length > WRITE_MAX_BYTES)
			throw tooLarge("the edited file", out.length);

		// 3. Race check, best effort: the API has no conditional write.
		const now = await files.stat(args.path, o());
		if (
			now.sizeBytes !== before.sizeBytes ||
			now.modifiedAt !== before.modifiedAt
		) {
			throw changedError();
		}

		// 4. Write with the old mode.
		await files.writeBytes(args.path, out, { mode: before.mode, ...o() });
		const context = contextAround(next, first, args.new_text);
		return toolText(
			{
				path: args.path,
				replacements: matches,
				size: out.length,
				context_from_line: context.from,
			},
			[fenceUntrusted([{ label: LABEL_CONTEXT, text: context.lines }])],
		);
	},
});

function changedError(): ToolError {
	return new ToolError({
		code: "conflict",
		message: "file changed since read, retry",
		retryable: true,
		hint: "the file was changed by someone else and nothing was written; call files_edit again.",
	});
}

/**
 * One listing line must stay one line: line breaks are written out, the rest
 * of the sandbox text is made safe like any fenced text.
 */
function oneLine(s: string): string {
	return sanitizeForLlm(
		s.replaceAll("\n", "\\u{0A}").replaceAll("\r", "\\u{0D}"),
	);
}

const TYPE_LETTER: Record<FileInfo["type"], string> = {
	dir: "d",
	file: "f",
	symlink: "l",
	other: "o",
};

function listLine(e: FileInfo, dir: string): string {
	const rel = e.path.startsWith(`${dir}/`)
		? e.path.slice(dir.length + 1)
		: e.path;
	const target =
		e.symlinkTarget === null ? "" : ` -> ${oneLine(e.symlinkTarget)}`;
	return `${TYPE_LETTER[e.type]} ${e.sizeBytes} ${e.modifiedAt ?? "-"} ${oneLine(rel)}${target}`;
}

export const filesList = defineTool({
	name: "files_list",
	title: "List a directory",
	description:
		"Lists a directory, one line per entry: d|f|l|o (directory, file, symlink, other), size, modified time, path, symlink target. Up to 200 entries per call; continue with cursor.",
	toolset: "files",
	scopes: ["files:read"],
	annotations: READ_ONLY,
	sandboxArg: true,
	shape: {
		path: z.string().optional().describe("Directory (default: home)"),
		depth: z
			.number()
			.int()
			.min(1)
			.max(3)
			.optional()
			.describe("Levels (default 1)"),
		include_hidden: z
			.boolean()
			.optional()
			.describe("Include dotfiles (default true)"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(LIST_MAX)
			.optional()
			.describe(`Max entries (default ${LIST_MAX})`),
		cursor: z.string().optional().describe("next_cursor of the last answer"),
		user: userShape,
	},
	async handler(args, ctx) {
		const path = args.path ?? "~";
		const sandbox = { sandbox: args.sandbox };
		const files = ctx.sbx().sandboxes.handle(args.sandbox).files;
		// The directory's own path: entries are shown relative to it.
		const [{ data }, dir] = await Promise.all([
			ctx.sbx().raw.GET(`${FILES_PATH}/list`, {
				params: {
					path: sandbox,
					query: {
						path,
						depth: args.depth ?? 1,
						includeHidden: args.include_hidden === false ? "false" : "true",
						limit: args.limit ?? LIST_MAX,
						...compact({ cursor: args.cursor, user: args.user }),
					},
				},
				...ctx.call,
			}),
			files.stat(path, { ...compact({ user: args.user }), ...ctx.call }),
		]);
		const prefix = dir.path === "/" ? "" : dir.path.replace(/\/+$/, "");
		const lines = data.data.map((e) => listLine(e, prefix));
		const next = data.nextCursor ?? undefined;
		return toolText({ path, entries: lines.length, next_cursor: next }, [
			...(next === undefined
				? []
				: [
						`more entries: call files_list again with the same arguments and cursor=${next}`,
					]),
			...(lines.length === 0
				? []
				: [fenceUntrusted([{ label: LABEL_LISTING, text: lines.join("\n") }])]),
		]);
	},
});

export const filesStat = defineTool({
	name: "files_stat",
	title: "Stat a path",
	description:
		"Tells whether a path exists and gives its type, size, mode and modified time. A missing path is a normal answer (exists: false), not an error.",
	toolset: "files",
	scopes: ["files:read"],
	annotations: READ_ONLY,
	sandboxArg: true,
	shape: { path: pathShape, user: userShape },
	async handler(args, ctx) {
		let info: FileInfo;
		try {
			info = await ctx
				.sbx()
				.sandboxes.handle(args.sandbox)
				.files.stat(args.path, {
					...compact({ user: args.user }),
					...ctx.call,
				});
		} catch (err) {
			if (err instanceof SbxError && err.code === "path_not_found") {
				return toolText({ path: args.path, exists: false });
			}
			throw err;
		}
		// Owner, group and the paths the sandbox chose are sandbox text: fenced,
		// one `key: value` line each. The header keeps what the server knows.
		const details = [
			`owner: ${oneLine(info.owner)}`,
			`group: ${oneLine(info.group)}`,
			...(info.symlinkTarget === null
				? []
				: [`symlink_target: ${oneLine(info.symlinkTarget)}`]),
			...(info.path === args.path
				? []
				: [`resolved_path: ${oneLine(info.path)}`]),
		];
		return toolText(
			{
				path: args.path,
				exists: true,
				type: info.type,
				size: info.sizeBytes,
				mode: octalMode(info.mode),
				modified_at: info.modifiedAt,
			},
			[fenceUntrusted([{ label: LABEL_STAT, text: details.join("\n") }])],
		);
	},
});

export const filesDelete = defineTool({
	name: "files_delete",
	title: "Delete a file or directory",
	description:
		"Deletes a file or directory; a non-empty directory needs recursive. It cannot be undone: delete only what you created. A missing path answers existed: false.",
	toolset: "files",
	scopes: ["files:write"],
	annotations: REPEATABLE_DESTRUCTIVE,
	sandboxArg: true,
	shape: {
		path: pathShape,
		recursive: z
			.boolean()
			.optional()
			.describe("Delete a non-empty directory (default false)"),
		user: userShape,
	},
	async handler(args, ctx) {
		const recursive = args.recursive === true;
		const { existed } = await ctx
			.sbx()
			.sandboxes.handle(args.sandbox)
			.files.remove(args.path, {
				recursive,
				...compact({ user: args.user }),
				...ctx.call,
			});
		return toolText({
			path: args.path,
			existed,
			...(recursive ? { recursive: true } : {}),
		});
	},
});

export const FILE_TOOLS = [
	filesRead,
	filesWrite,
	filesEdit,
	filesList,
	filesStat,
	filesDelete,
] as const;
