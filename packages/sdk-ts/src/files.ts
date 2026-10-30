// Files of a sandbox (S7 §11.1, §15.4).
//
// - readText/readBytes and writeText/writeBytes: GET/PUT /files/content.
// - upload: resumable chunked upload (4 MiB chunks by default). A chunk whose
//   answer was lost shows up as 409 upload_offset_mismatch and is skipped; a
//   failed chunk is resumed from the offset of HEAD .../uploads/{id}. The
//   sha256 is sent on commit when node:crypto is there (Node, Bun).
// - download: streams to a local path or a WritableStream, resuming after a
//   break with Range + If-Range (a changed file restarts a local path).
// - uploadDir/downloadDir: one tar.gz stream through /files/archive with the
//   system `tar` (Node and Bun only). Not resumable: a failure repeats the
//   whole archive (overwrite=true makes that safe).
// Paths are absolute or relative to the home directory of `user`.

import type { CallOptions } from "./client.ts";
import { callOf, type SandboxRef } from "./commands.ts";
import { NETWORK_ERROR, SbxError } from "./errors.ts";
import type { components } from "./gen/v1.d.ts";
import { fsPromises, sha256Hasher, tarCreate, tarExtract } from "./node.ts";
import { paginate } from "./pages.ts";
import { isRetryable, retryDelayMs, sleep, withRetry } from "./retry.ts";

export type FileInfo = components["schemas"]["FileInfo"];
export type ArchiveResult = components["schemas"]["ArchiveResult"];

export interface UserOption {
	/** Guest user whose home resolves relative paths (default `user`). */
	user?: string;
}

export interface WriteOptions extends CallOptions, UserOption {
	/** Permission bits, e.g. 0o644. */
	mode?: number;
	/** Create missing parent directories (default true). */
	makeParents?: boolean;
	/** Replace an existing file (default true). */
	overwrite?: boolean;
}

export interface UploadOptions extends WriteOptions {
	/** Chunk size in bytes; default the api's (4 MiB), at most its maximum (8 MiB). */
	chunkSize?: number;
	/** Called after each acknowledged chunk with the bytes uploaded so far. */
	onProgress?: (bytes: number) => void;
}

/** What `upload` reads: bytes, a Blob/File, a stream, or a local path (Node, Bun). */
export type UploadSource =
	| Uint8Array
	| Blob
	| ReadableStream<Uint8Array>
	| string;

export interface DownloadResult {
	sizeBytes: number;
	etag: string | null;
}

const FILES = "/v1/sandboxes/{sandbox}/files";
const UPLOADS = "/v1/sandboxes/{sandbox}/files/uploads";
const UPLOAD = "/v1/sandboxes/{sandbox}/files/uploads/{upload}";
/** Attempts in a row without progress before an upload or download gives up. */
const MAX_FAILURES = 20;

const bool = (v: boolean) => (v ? "true" : "false") as "true" | "false";
const rawBody = (b: unknown) => b as BodyInit;
const OCTET = { "Content-Type": "application/octet-stream" };

function userQuery(o: UserOption) {
	return o.user === undefined ? {} : { user: o.user };
}

export class Files {
	readonly #sb: SandboxRef;

	constructor(sb: SandboxRef) {
		this.#sb = sb;
	}

	get #raw() {
		return this.#sb.core.raw;
	}

	#sandbox() {
		return { sandbox: this.#sb.id };
	}

	async readBytes(
		path: string,
		opts: CallOptions & UserOption = {},
	): Promise<Uint8Array> {
		const { data } = await this.#raw.GET(`${FILES}/content`, {
			params: { path: this.#sandbox(), query: { path, ...userQuery(opts) } },
			parseAs: "arrayBuffer",
			...callOf(opts),
		});
		return new Uint8Array(
			(data as ArrayBuffer | undefined) ?? new ArrayBuffer(0),
		);
	}

	async readText(
		path: string,
		opts: CallOptions & UserOption = {},
	): Promise<string> {
		return new TextDecoder().decode(await this.readBytes(path, opts));
	}

	/** Atomic write of the whole file (PUT /files/content); retried as a whole. */
	async writeBytes(
		path: string,
		data: Uint8Array | string,
		opts: WriteOptions = {},
	): Promise<FileInfo> {
		const bytes =
			typeof data === "string" ? new TextEncoder().encode(data) : data;
		const { data: info } = await this.#raw.PUT(`${FILES}/content`, {
			params: { path: this.#sandbox(), query: writeQuery(path, opts) },
			body: bytes as never,
			bodySerializer: rawBody,
			headers: OCTET,
			...callOf(opts),
		});
		return info;
	}

	writeText(
		path: string,
		text: string,
		opts: WriteOptions = {},
	): Promise<FileInfo> {
		return this.writeBytes(path, text, opts);
	}

	async stat(
		path: string,
		opts: CallOptions & UserOption & { noFollow?: boolean } = {},
	): Promise<FileInfo> {
		const { data } = await this.#raw.GET(`${FILES}/stat`, {
			params: {
				path: this.#sandbox(),
				query: {
					path,
					...userQuery(opts),
					...(opts.noFollow === undefined
						? {}
						: { noFollow: bool(opts.noFollow) }),
				},
			},
			...callOf(opts),
		});
		return data;
	}

	/** Entries of a directory, all pages (`depth` 1–8, hidden files included by default). */
	list(
		path: string,
		opts: CallOptions &
			UserOption & {
				depth?: number;
				includeHidden?: boolean;
				limit?: number;
			} = {},
	): AsyncIterable<FileInfo> {
		return paginate(async (cursor) => {
			const { data } = await this.#raw.GET(`${FILES}/list`, {
				params: {
					path: this.#sandbox(),
					query: {
						path,
						...userQuery(opts),
						...(opts.depth === undefined ? {} : { depth: opts.depth }),
						...(opts.includeHidden === undefined
							? {}
							: { includeHidden: bool(opts.includeHidden) }),
						...(opts.limit === undefined ? {} : { limit: opts.limit }),
						...(cursor === undefined ? {} : { cursor }),
					},
				},
				...callOf(opts),
			});
			return data;
		});
	}

	async mkdir(
		path: string,
		opts: CallOptions & UserOption & { parents?: boolean; mode?: number } = {},
	): Promise<FileInfo> {
		const { data } = await this.#raw.POST(`${FILES}/mkdir`, {
			params: { path: this.#sandbox(), query: userQuery(opts) },
			body: {
				path,
				...(opts.parents === undefined ? {} : { parents: opts.parents }),
				...(opts.mode === undefined ? {} : { mode: opts.mode }),
			},
			...callOf(opts),
		});
		return data;
	}

	async move(
		from: string,
		to: string,
		opts: CallOptions & UserOption & { overwrite?: boolean } = {},
	): Promise<FileInfo> {
		const { data } = await this.#raw.POST(`${FILES}/move`, {
			params: { path: this.#sandbox(), query: userQuery(opts) },
			body: {
				from,
				to,
				...(opts.overwrite === undefined ? {} : { overwrite: opts.overwrite }),
			},
			...callOf(opts),
		});
		return data;
	}

	async chmod(
		path: string,
		opts: CallOptions &
			UserOption & {
				mode?: number;
				owner?: string;
				group?: string;
				recursive?: boolean;
			},
	): Promise<FileInfo> {
		const body: components["schemas"]["ChmodRequest"] = { path };
		if (opts.mode !== undefined) body.mode = opts.mode;
		if (opts.owner !== undefined) body.owner = opts.owner;
		if (opts.group !== undefined) body.group = opts.group;
		if (opts.recursive !== undefined) body.recursive = opts.recursive;
		const { data } = await this.#raw.POST(`${FILES}/chmod`, {
			params: { path: this.#sandbox(), query: userQuery(opts) },
			body,
			...callOf(opts),
		});
		return data;
	}

	/** Deletes a file or directory; `existed: false` when there was nothing. */
	async remove(
		path: string,
		opts: CallOptions & UserOption & { recursive?: boolean } = {},
	): Promise<{ existed: boolean }> {
		const { data } = await this.#raw.DELETE(FILES, {
			params: {
				path: this.#sandbox(),
				query: {
					path,
					...userQuery(opts),
					...(opts.recursive === undefined
						? {}
						: { recursive: bool(opts.recursive) }),
				},
			},
			...callOf(opts),
		});
		return data;
	}

	/** Resumable chunked upload (S7 §11.1); returns the committed file. */
	async upload(
		path: string,
		src: UploadSource,
		opts: UploadOptions = {},
	): Promise<FileInfo> {
		const call = callOf(opts);
		const source = await openSource(src);
		try {
			const { data: up } = await this.#raw.POST(UPLOADS, {
				params: { path: this.#sandbox() },
				body: { path },
				...call,
			});
			const chunkSize = Math.max(
				1,
				Math.min(opts.chunkSize ?? up.chunkSizeBytes, up.maxChunkSizeBytes),
			);
			const uploadPath = {
				path: { ...this.#sandbox(), upload: up.uploadId },
			};
			const hash = sha256Hasher();
			let acked = 0;
			let chunk: Uint8Array | null = null;
			let chunkStart = 0;
			let sentAny = false;
			let failures = 0;
			for (;;) {
				call.signal?.throwIfAborted();
				if (chunk === null) {
					chunk = await source.read(acked, chunkSize);
					chunkStart = acked;
					// An empty first chunk still creates the (empty) upload.
					if (chunk.length === 0 && sentAny) break;
				}
				let serverOffset: number;
				try {
					const { data, response } = await this.#raw.PUT(UPLOAD, {
						params: {
							...uploadPath,
							query: { offset: chunkStart, path, ...userQuery(opts) },
						},
						body: chunk as never,
						bodySerializer: rawBody,
						headers: OCTET,
						...call,
					});
					serverOffset = uploadOffset(response, data?.offset);
				} catch (err) {
					const mismatch = mismatchOffset(err);
					if (mismatch === null) {
						// A chunk PUT is safe to repeat (the offset guards it).
						if (!(err instanceof SbxError) || !isRetryable(err, true)) {
							throw err;
						}
						failures += 1;
						if (failures >= MAX_FAILURES) throw err;
						await sleep(retryDelayMs(err, failures - 1), call.signal);
						const known = await this.#headOffset(uploadPath, call);
						if (known === null) continue; // repeat the same chunk
						serverOffset = known;
					} else {
						serverOffset = mismatch;
					}
				}
				sentAny = true;
				const end = chunkStart + chunk.length;
				if (serverOffset === end) {
					hash?.update(chunk);
					acked = end;
					chunk = null;
					failures = 0;
				} else if (serverOffset > chunkStart && serverOffset < end) {
					// Part of the chunk arrived: send the rest.
					const done = serverOffset - chunkStart;
					hash?.update(chunk.subarray(0, done));
					chunk = chunk.subarray(done);
					chunkStart = serverOffset;
					acked = serverOffset;
					failures = 0;
				} else if (serverOffset === chunkStart) {
					// Nothing of the chunk arrived; repeat it.
				} else if (serverOffset === 0 && source.seekable) {
					// The agent lost the upload: start again from the first byte.
					return await this.upload(path, src, opts);
				} else {
					throw new SbxError({
						status: 0,
						code: "upload_offset_mismatch",
						message: `the upload is at ${serverOffset}, this client at ${chunkStart}`,
						retryable: false,
						details: { offset: serverOffset },
					});
				}
				opts.onProgress?.(acked);
			}
			const body: components["schemas"]["CommitUploadRequest"] = { path };
			if (hash) body.sha256 = hash.hex();
			if (opts.mode !== undefined) body.mode = opts.mode;
			if (opts.overwrite !== undefined) body.overwrite = opts.overwrite;
			if (opts.makeParents !== undefined) body.makeParents = opts.makeParents;
			const { data: info } = await this.#raw.POST(`${UPLOAD}/commit`, {
				params: { ...uploadPath, query: userQuery(opts) },
				body,
				...call,
				// Commit is idempotent by uploadId: safe to repeat after a lost answer.
				idempotencyKey: up.uploadId,
			});
			return info;
		} finally {
			await source.close();
		}
	}

	/** Sbx-Upload-Offset of HEAD; 0 when the agent has no upload; null when unknown. */
	async #headOffset(
		uploadPath: { path: { sandbox: string; upload: string } },
		call: CallOptions,
	): Promise<number | null> {
		try {
			const { response } = await this.#raw.HEAD(UPLOAD, {
				params: uploadPath,
				...call,
			});
			return uploadOffset(response, undefined);
		} catch (err) {
			if (err instanceof SbxError && err.status === 404) return 0;
			if (err instanceof SbxError && isRetryable(err, true)) return null;
			throw err;
		}
	}

	/**
	 * Downloads to a local path (Node, Bun) or a WritableStream. A break is
	 * resumed with Range + If-Range; if the file changed meanwhile, a local
	 * path starts again and a stream fails with `file_changed`.
	 */
	async download(
		path: string,
		dest: string | WritableStream<Uint8Array>,
		opts: CallOptions & UserOption = {},
	): Promise<DownloadResult> {
		const call = callOf(opts);
		const sink = await openSink(dest);
		let ok = false;
		try {
			let received = 0;
			let total: number | null = null;
			let etag: string | null = null;
			let failures = 0;
			for (;;) {
				call.signal?.throwIfAborted();
				const headers: Record<string, string> = {};
				if (received > 0) {
					headers.Range = `bytes=${received}-`;
					if (etag !== null) headers["If-Range"] = etag;
				}
				let lastError: unknown;
				const before = received;
				try {
					const { data, response } = await this.#raw.GET(`${FILES}/content`, {
						params: {
							path: this.#sandbox(),
							query: { path, ...userQuery(opts) },
						},
						headers,
						parseAs: "stream",
						...call,
					});
					if (response.status === 200 && received > 0) {
						// The file changed (If-Range did not match): start again.
						await sink.reset();
						received = 0;
					}
					etag = response.headers.get("ETag") ?? etag;
					total = totalSize(response) ?? total;
					if (data) {
						const reader = (data as ReadableStream<Uint8Array>).getReader();
						try {
							for (;;) {
								const r = await reader.read();
								if (r.done) break;
								await sink.write(r.value);
								received += r.value.length;
							}
						} finally {
							reader.releaseLock();
						}
					}
					if (total === null || received >= total) {
						ok = true;
						return { sizeBytes: received, etag };
					}
					lastError = broken("the download ended early");
				} catch (err) {
					if (call.signal?.aborted) throw call.signal.reason;
					if (
						err instanceof SbxError &&
						err.code === "range_not_satisfiable" &&
						total !== null &&
						received >= total
					) {
						ok = true;
						return { sizeBytes: received, etag };
					}
					if (err instanceof SbxError && !isRetryable(err, true)) throw err;
					lastError =
						err instanceof SbxError
							? err
							: broken(`the download broke: ${String(err)}`, err);
				}
				failures = received > before ? 0 : failures + 1;
				if (failures >= MAX_FAILURES) throw lastError;
				await sleep(
					retryDelayMs(lastError, Math.max(0, failures - 1)),
					call.signal,
				);
			}
		} finally {
			await sink.close(ok);
		}
	}

	/**
	 * Packs a local directory with the system tar (gzip) and unpacks it into
	 * `path` (created if missing). The whole archive is repeated on failure.
	 */
	async uploadDir(
		localDir: string,
		path: string,
		opts: CallOptions & UserOption & { overwrite?: boolean } = {},
	): Promise<ArchiveResult> {
		const fs = fsPromises("uploadDir");
		const names = await fs.readdir(localDir);
		const call = callOf(opts);
		if (names.length === 0) {
			const info = await this.mkdir(path, { ...opts, parents: true });
			return { path: info.path, entries: 0, sizeBytes: 0 };
		}
		return withRetry(
			async () => {
				const tar = tarCreate(localDir, names);
				let tarError: unknown;
				tar.done.catch((e: unknown) => {
					tarError = e;
				});
				try {
					const { data } = await this.#raw.PUT(`${FILES}/archive`, {
						params: {
							path: this.#sandbox(),
							query: {
								path,
								format: "tar.gz",
								makeParents: "true",
								overwrite: bool(opts.overwrite ?? true),
								...userQuery(opts),
							},
						},
						body: tar.body as never,
						bodySerializer: rawBody,
						headers: OCTET,
						...call,
					});
					await tar.done;
					return data;
				} catch (err) {
					// A tar failure (it ends the body) is the real cause.
					throw tarError ?? err;
				} finally {
					tar.kill();
				}
			},
			{
				method: "PUT",
				signal: call.signal,
				budgetMs: call.retryBudgetMs,
			},
		);
	}

	/**
	 * Downloads a directory as tar.gz and unpacks it with the system tar into
	 * `localDir` (created if missing). The archive comes from the sandbox:
	 * extraction does not keep owners, and tar refuses `..` and absolute names.
	 */
	async downloadDir(
		path: string,
		localDir: string,
		opts: CallOptions & UserOption = {},
	): Promise<void> {
		const fs = fsPromises("downloadDir");
		await fs.mkdir(localDir, { recursive: true });
		const call = callOf(opts);
		await withRetry(
			async () => {
				const tar = tarExtract(localDir);
				try {
					const { data } = await this.#raw.GET(`${FILES}/archive`, {
						params: {
							path: this.#sandbox(),
							query: { path, format: "tar.gz", ...userQuery(opts) },
						},
						parseAs: "stream",
						...call,
					});
					const body = data as ReadableStream<Uint8Array> | null | undefined;
					if (!body) throw broken("the archive answer has no body");
					try {
						await body.pipeTo(tar.sink);
					} catch (err) {
						if (call.signal?.aborted) throw call.signal.reason;
						// A broken download: repeat the whole archive.
						throw err instanceof SbxError
							? err
							: broken(`the archive download broke: ${String(err)}`, err);
					}
					await tar.done;
				} finally {
					tar.kill();
				}
			},
			{ method: "GET", signal: call.signal, budgetMs: call.retryBudgetMs },
		);
	}
}

function writeQuery(path: string, o: WriteOptions) {
	return {
		path,
		...userQuery(o),
		...(o.mode === undefined ? {} : { mode: o.mode.toString(8) }),
		makeParents: bool(o.makeParents ?? true),
		overwrite: bool(o.overwrite ?? true),
	};
}

function broken(message: string, cause?: unknown): SbxError {
	return new SbxError({
		status: 0,
		code: NETWORK_ERROR,
		message,
		retryable: true,
		...(cause === undefined ? {} : { cause }),
	});
}

function uploadOffset(res: Response, fromBody: number | undefined): number {
	const h = res.headers.get("Sbx-Upload-Offset");
	const v = h === null ? fromBody : Number(h);
	if (v === undefined || !Number.isFinite(v)) {
		throw new SbxError({
			status: res.status,
			code: "unexpected_response",
			message: "the upload answer has no offset",
			retryable: false,
			requestId: res.headers.get("Request-Id"),
		});
	}
	return v;
}

/** The current upload size from a 409 upload_offset_mismatch, else null. */
function mismatchOffset(err: unknown): number | null {
	if (!(err instanceof SbxError) || err.code !== "upload_offset_mismatch") {
		return null;
	}
	const v = Number(err.details.offset);
	return Number.isFinite(v) ? v : null;
}

/** Size of the whole file from Content-Range (206) or Content-Length (200). */
function totalSize(res: Response): number | null {
	const range = res.headers.get("Content-Range");
	const m = range?.match(/\/(\d+)$/);
	if (m?.[1] !== undefined) return Number(m[1]);
	if (res.status !== 200) return null;
	const len = res.headers.get("Content-Length");
	return len === null ? null : Number(len);
}

interface Source {
	seekable: boolean;
	/** Up to `length` bytes at `offset`; empty at the end. */
	read(offset: number, length: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

async function openSource(src: UploadSource): Promise<Source> {
	if (src instanceof Uint8Array) {
		return {
			seekable: true,
			read: async (o, n) => src.subarray(o, o + n),
			close: async () => {},
		};
	}
	if (typeof src === "string") {
		const fh = await fsPromises("upload from a local path").open(src, "r");
		return {
			seekable: true,
			async read(o, n) {
				const buf = new Uint8Array(n);
				let got = 0;
				while (got < n) {
					const r = await fh.read(buf, got, n - got, o + got);
					if (r.bytesRead === 0) break;
					got += r.bytesRead;
				}
				return buf.subarray(0, got);
			},
			close: () => fh.close(),
		};
	}
	if (src instanceof ReadableStream) return streamSource(src);
	const blob = src;
	return {
		seekable: true,
		read: async (o, n) =>
			new Uint8Array(await blob.slice(o, o + n).arrayBuffer()),
		close: async () => {},
	};
}

/** A stream read forward only, in chunks of the asked size. */
function streamSource(stream: ReadableStream<Uint8Array>): Source {
	const reader = stream.getReader();
	let pos = 0;
	let rest: Uint8Array = new Uint8Array(0);
	let ended = false;
	return {
		seekable: false,
		async read(offset, n) {
			if (offset !== pos) {
				throw new SbxError({
					status: 0,
					code: "upload_offset_mismatch",
					message: "a stream source cannot go back",
					retryable: false,
				});
			}
			const parts: Uint8Array[] = [];
			let got = 0;
			while (got < n) {
				if (rest.length === 0) {
					if (ended) break;
					const r = await reader.read();
					if (r.done) {
						ended = true;
						break;
					}
					rest = r.value;
				}
				const take = rest.subarray(0, n - got);
				parts.push(take);
				got += take.length;
				rest = rest.subarray(take.length);
			}
			pos += got;
			if (parts.length === 1) return parts[0] as Uint8Array;
			const out = new Uint8Array(got);
			let at = 0;
			for (const p of parts) {
				out.set(p, at);
				at += p.length;
			}
			return out;
		},
		async close() {
			if (!ended) await reader.cancel().catch(() => {});
			reader.releaseLock();
		},
	};
}

interface Sink {
	write(b: Uint8Array): Promise<void>;
	/** Drops what was written (the file changed); a stream cannot. */
	reset(): Promise<void>;
	close(ok: boolean): Promise<void>;
}

async function openSink(
	dest: string | WritableStream<Uint8Array>,
): Promise<Sink> {
	if (typeof dest === "string") {
		const fh = await fsPromises("download to a local path").open(dest, "w");
		let pos = 0;
		return {
			async write(b) {
				let done = 0;
				while (done < b.length) {
					const r = await fh.write(b, done, b.length - done, pos);
					done += r.bytesWritten;
					pos += r.bytesWritten;
				}
			},
			async reset() {
				await fh.truncate(0);
				pos = 0;
			},
			close: () => fh.close(),
		};
	}
	const writer = dest.getWriter();
	let wrote = false;
	return {
		async write(b) {
			wrote = true;
			await writer.write(b);
		},
		async reset() {
			if (!wrote) return;
			throw new SbxError({
				status: 0,
				code: "file_changed",
				message: "the file changed during the download",
				retryable: false,
			});
		},
		async close(ok) {
			if (ok) await writer.close();
			else await writer.abort().catch(() => {});
		},
	};
}
