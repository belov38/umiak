// The filesystem of one FakeAgent machine: a guest root directory that
// stands for "/" of the VM, the Filesystem RPC over it and the agent's HTTP
// `/files*` (S3 §11). Guest paths never leave the root: ".." above "/" and
// symlinks that resolve outside it are invalid_path.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	lstatSync,
	mkdirSync,
	realpathSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";
import type { AgentFetchInit } from "@umiak/agent-client";
import { AgentCallError } from "../agent/errors.ts";
import { agentFileInfoJson } from "../agent/files-http.ts";
import type {
	AgentChmodRequest,
	AgentFileInfo,
	AgentListRequest,
	AgentListResult,
	AgentMakeDirRequest,
	AgentMakeDirResult,
	AgentMoveRequest,
	AgentRemoveRequest,
	AgentStatRequest,
} from "../agent/types.ts";
import {
	readTarEntries,
	type TarEntry,
	TarFormatError,
} from "./tar-headers.ts";

/** Home of the default user inside the guest. */
export const GUEST_HOME = "/home/user";

export interface FilesLimits {
	maxChunkBytes: number;
	archiveMaxEntries: number;
	archiveMaxBytes: number;
	archiveMaxPath: number;
}

/** A path as the guest sees it and where it lives on the host. */
export interface GuestPath {
	guest: string;
	host: string;
}

interface Upload {
	tempPath: string;
	size: number;
	/** The stored FileInfo JSON of a committed upload. */
	commit: string | null;
}

export class MachineFiles {
	/** Host directory that is "/" of the guest (realpath-resolved). */
	readonly root: string;
	/** Host directory of GUEST_HOME. */
	readonly home: string;
	readonly #spool: string;
	readonly #limits: FilesLimits;
	readonly #tars: Set<ChildProcess>;
	readonly #uploads = new Map<string, Upload>();
	#uploadLock: Promise<unknown> = Promise.resolve();

	/** `dir` is a new empty directory; `tars` collects tar children for close(). */
	constructor(dir: string, limits: FilesLimits, tars: Set<ChildProcess>) {
		mkdirSync(join(dir, "root"));
		mkdirSync(join(dir, "spool"));
		this.root = realpathSync(join(dir, "root"));
		this.#spool = realpathSync(join(dir, "spool"));
		this.home = join(this.root, GUEST_HOME);
		mkdirSync(this.home, { recursive: true });
		this.#limits = limits;
		this.#tars = tars;
	}

	/**
	 * S3 §11.1: "~", "~/x" and relative paths are under GUEST_HOME. ".." above
	 * "/" is invalid_path, and so is a path whose existing part resolves
	 * outside the root through a symlink. `follow` false checks only the
	 * parent, for calls that act on a symlink itself.
	 */
	resolve(p: string, follow = true): GuestPath {
		if (p === "") throw callError("invalid_path", "path is empty");
		if (p.includes("\0")) {
			throw callError("invalid_path", "path contains a NUL byte");
		}
		const abs =
			p === "~"
				? GUEST_HOME
				: p.startsWith("~/")
					? `${GUEST_HOME}/${p.slice(2)}`
					: p.startsWith("/")
						? p
						: `${GUEST_HOME}/${p}`;
		const comps: string[] = [];
		for (const c of abs.split("/")) {
			if (c === "" || c === ".") continue;
			if (c !== "..") comps.push(c);
			else if (comps.pop() === undefined) {
				throw callError("invalid_path", `${p}: leaves the filesystem root`);
			}
		}
		const host = join(this.root, ...comps);
		this.#contain(follow || comps.length === 0 ? host : dirname(host), p);
		return { guest: `/${comps.join("/")}`, host };
	}

	/** The deepest existing part of `host` must resolve inside the root. */
	#contain(host: string, p: string): void {
		let at = host;
		for (;;) {
			let real: string | null = null;
			try {
				real = realpathSync(at);
			} catch (e) {
				const code = errnoOf(e);
				if (code !== "ENOENT" && code !== "ENOTDIR") throw fsError(e);
				// A dangling symlink could point anywhere.
				if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) {
					throw callError("invalid_path", `${p}: dangling symlink`);
				}
			}
			if (real !== null) {
				if (real !== this.root && !real.startsWith(`${this.root}/`)) {
					throw callError("invalid_path", `${p}: resolves outside the root`);
				}
				return;
			}
			if (at === this.root) return;
			at = dirname(at);
		}
	}

	// --- Filesystem RPC ---

	stat(req: AgentStatRequest): Promise<AgentFileInfo> {
		const p = this.resolve(req.path, !req.noFollow);
		return fsCall(() => fileInfo(p, !req.noFollow));
	}

	async list(req: AgentListRequest): Promise<AgentListResult> {
		const dir = this.resolve(req.path);
		const depth = req.depth || 1;
		if (depth > 8) {
			throw callError("invalid_argument", `depth ${depth} is above 8`);
		}
		const pageSize = Math.min(req.pageSize || 1000, 10_000);
		const st = await fsCall(() => fsp.stat(dir.host));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${dir.guest} is not a directory`);
		}
		const all: { rel: string[]; info: AgentFileInfo }[] = [];
		const walk = async (at: GuestPath, rel: string[], level: number) => {
			const names = (await fsp.readdir(at.host)).sort();
			for (const name of names) {
				if (req.includeHidden === false && name.startsWith(".")) continue;
				const child = {
					host: join(at.host, name),
					guest: at.guest === "/" ? `/${name}` : `${at.guest}/${name}`,
				};
				const info = await fileInfo(child, false).catch(() => null);
				if (info === null) continue;
				all.push({ rel: [...rel, name], info });
				if (info.type === "dir" && level < depth) {
					await walk(child, [...rel, name], level + 1).catch(() => {});
				}
			}
		};
		await fsCall(() => walk(dir, [], 1));
		let from = 0;
		if (req.pageToken) {
			const tok = this.resolve(req.pageToken, false).guest;
			const prefix = dir.guest === "/" ? "/" : `${dir.guest}/`;
			if (!tok.startsWith(prefix)) {
				throw callError(
					"invalid_argument",
					`page_token is not under ${dir.guest}`,
				);
			}
			const after = tok.slice(prefix.length).split("/");
			from = all.findIndex((e) => compareComponents(e.rel, after) > 0);
			if (from < 0) from = all.length;
		}
		const page = all.slice(from, from + pageSize);
		const more = from + pageSize < all.length;
		return {
			entries: page.map((e) => e.info),
			nextPageToken: more ? (page.at(-1)?.info.path ?? "") : "",
		};
	}

	makeDir(req: AgentMakeDirRequest): Promise<AgentMakeDirResult> {
		const p = this.resolve(req.path);
		return fsCall(async () => {
			const st = await fsp.stat(p.host).catch(() => null);
			if (st !== null) {
				if (!st.isDirectory()) {
					throw callError("already_exists", `${p.guest} exists`);
				}
				return { info: await fileInfo(p, true), created: false };
			}
			const mode = req.mode ?? 0o755;
			await fsp.mkdir(p.host, { recursive: req.parents === true, mode });
			await fsp.chmod(p.host, mode);
			return { info: await fileInfo(p, true), created: true };
		});
	}

	move(req: AgentMoveRequest): Promise<AgentFileInfo> {
		const src = this.resolve(req.src, false);
		const dst = this.resolve(req.dst, false);
		return fsCall(async () => {
			await fsp.lstat(src.host);
			if (
				!req.overwrite &&
				(await fsp.lstat(dst.host).catch(() => null)) !== null
			) {
				throw callError("already_exists", `${dst.guest} already exists`);
			}
			await fsp.rename(src.host, dst.host);
			return fileInfo(dst, false);
		});
	}

	chmod(req: AgentChmodRequest): Promise<AgentFileInfo> {
		const p = this.resolve(req.path);
		return fsCall(async () => {
			const mode = req.mode;
			if (mode !== undefined) {
				const apply = async (q: string): Promise<void> => {
					const st = await fsp.lstat(q);
					if (st.isSymbolicLink()) return;
					await fsp.chmod(q, mode);
					if (req.recursive && st.isDirectory()) {
						for (const n of await fsp.readdir(q)) await apply(join(q, n));
					}
				};
				await fsp.stat(p.host);
				await apply(await fsp.realpath(p.host));
			}
			// owner and group: the fake runs unprivileged and cannot chown.
			return fileInfo(p, true);
		});
	}

	remove(req: AgentRemoveRequest): Promise<{ existed: boolean }> {
		const p = this.resolve(req.path, false);
		if (p.host === this.root) {
			throw callError("invalid_path", "the root cannot be removed");
		}
		return fsCall(async () => {
			const st = await fsp.lstat(p.host).catch((e: unknown) => {
				if (errnoOf(e) === "ENOENT") return null;
				throw e;
			});
			if (st === null) return { existed: false };
			if (!st.isDirectory()) await fsp.unlink(p.host);
			else if (req.recursive) {
				await fsp.rm(p.host, { recursive: true, force: true });
			} else await fsp.rmdir(p.host);
			return { existed: true };
		});
	}

	// --- HTTP /files* ---

	/** One `/files<path>` request; agent errors become JSON error responses. */
	async serve(path: string, init: AgentFetchInit): Promise<Response> {
		const url = new URL(`http://agent/files${path}`);
		const method = (init.method ?? "GET").toUpperCase();
		const raw = typeof init.body === "function" ? init.body() : init.body;
		const reqInit: RequestInit & { duplex?: "half" } = {
			method,
			signal: init.signal ?? null,
		};
		if (init.headers !== undefined) reqInit.headers = init.headers;
		if (raw != null && method !== "GET" && method !== "HEAD") {
			reqInit.body = raw;
			reqInit.duplex = "half";
		}
		const req = new Request(url, reqInit);
		try {
			return await this.#route(req, url);
		} catch (e) {
			return errorResponse(e);
		}
	}

	#route(req: Request, url: URL): Promise<Response> {
		const rest = url.pathname.slice("/files".length);
		const m = req.method;
		if (rest === "") {
			if (m === "GET" || m === "HEAD") return this.#download(req, url);
			if (m === "PUT") return this.#putFile(req, url);
			return Promise.resolve(methodNotAllowed("GET, HEAD, PUT"));
		}
		if (rest === "/archive") {
			if (m === "GET") return this.#archiveGet(url);
			if (m === "PUT") return this.#archivePut(req, url);
			return Promise.resolve(methodNotAllowed("GET, PUT"));
		}
		if (rest.startsWith("/uploads/")) {
			const segs = rest.slice("/uploads/".length).split("/");
			const id = segs[0] ?? "";
			if (segs.length > 2 || (segs.length === 2 && segs[1] !== "commit")) {
				return Promise.resolve(endpointNotFound());
			}
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
				throw callError("invalid_path", "invalid upload id");
			}
			const run = <T>(fn: () => Promise<T>): Promise<T> => {
				const p = this.#uploadLock.then(fn, fn);
				this.#uploadLock = p.catch(() => {});
				return p;
			};
			if (segs.length === 2) {
				if (m !== "POST") return Promise.resolve(methodNotAllowed("POST"));
				return run(() => this.#commit(req, id));
			}
			if (m === "PUT") return run(() => this.#putChunk(req, url, id));
			if (m === "HEAD") return run(() => this.#headUpload(id));
			if (m === "DELETE") return run(() => this.#deleteUpload(id));
			return Promise.resolve(methodNotAllowed("PUT, HEAD, DELETE"));
		}
		return Promise.resolve(endpointNotFound());
	}

	async #download(req: Request, url: URL): Promise<Response> {
		const p = this.resolve(url.searchParams.get("path") ?? "");
		const st = await fsCall(() => fsp.stat(p.host, { bigint: true }));
		if (st.isDirectory()) {
			throw callError("is_directory", `${p.guest} is a directory`);
		}
		if (!st.isFile()) {
			throw callError(
				"failed_precondition",
				`${p.guest} is not a regular file`,
			);
		}
		const size = Number(st.size);
		const etag = `"${st.ino}-${st.size}-${st.mtimeNs}"`;
		const mtime = new Date(Number(st.mtimeMs));
		const headers = new Headers({
			ETag: etag,
			"Last-Modified": mtime.toUTCString(),
			"Accept-Ranges": "bytes",
			"Content-Type": "application/octet-stream",
		});
		let range = req.headers.get("range");
		if (range?.includes(",")) range = null;
		const ifRange = req.headers.get("if-range");
		if (range !== null && ifRange !== null) {
			const matches =
				ifRange.startsWith('"') || ifRange.startsWith("W/")
					? ifRange === etag
					: Date.parse(ifRange) === Math.floor(mtime.getTime() / 1000) * 1000;
			if (!matches) range = null;
		}
		let start = 0;
		let end = size - 1;
		let status = 200;
		if (range !== null) {
			const r = parseRange(range, size);
			if (r === null) {
				return new Response("invalid range", {
					status: 416,
					headers: { "Content-Range": `bytes */${size}` },
				});
			}
			[start, end] = r;
			status = 206;
			headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		}
		const length = Math.max(0, end - start + 1);
		headers.set("Content-Length", String(length));
		const body =
			req.method === "HEAD" || length === 0
				? null
				: nodeToWeb(createReadStream(p.host, { start, end }));
		return new Response(body, { status, headers });
	}

	async #putFile(req: Request, url: URL): Promise<Response> {
		const q = url.searchParams;
		const p = this.resolve(q.get("path") ?? "");
		const mode = parseMode(q.get("mode")) ?? 0o644;
		const makeParents = queryBool(q, "make_parents", true);
		const overwrite = queryBool(q, "overwrite", true);
		const target = await prepareTarget(p, overwrite, makeParents);
		const tmp = join(dirname(target), `.umiak-tmp-${randomUUID()}`);
		try {
			await fsCall(() => writeBody(req, tmp, mode));
			await fsCall(() => fsp.chmod(tmp, mode));
			await fsCall(() => fsp.rename(tmp, target));
		} finally {
			await fsp.rm(tmp, { force: true });
		}
		return Response.json(agentFileInfoJson(await fileInfo(p, true)));
	}

	async #putChunk(req: Request, url: URL, id: string): Promise<Response> {
		const q = url.searchParams;
		const offsetText = q.get("offset") ?? "";
		if (!/^[0-9]{1,15}$/.test(offsetText)) {
			throw callError(
				"invalid_argument",
				`offset ${JSON.stringify(offsetText)} is not a non-negative integer`,
			);
		}
		const offset = Number(offsetText);
		const max = this.#limits.maxChunkBytes;
		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > max) throw chunkTooLarge(max);
		let up = this.#uploads.get(id);
		if (up?.commit != null) {
			throw callError(
				"failed_precondition",
				`upload ${id} is already committed`,
				{ offset: up.size },
				409,
			);
		}
		const current = up?.size ?? 0;
		if (offset !== current) throw offsetMismatch(current, offset);
		const data = await readCapped(req, max);
		if (data === null) throw chunkTooLarge(max);
		if (up === undefined) {
			up = {
				tempPath: join(this.#spool, `upload-${id}`),
				size: 0,
				commit: null,
			};
			const path = up.tempPath;
			await fsCall(() => fsp.writeFile(path, ""));
			this.#uploads.set(id, up);
		}
		const u = up;
		await fsCall(() => fsp.appendFile(u.tempPath, data));
		u.size += data.length;
		return Response.json(
			{ offset: u.size },
			{ headers: { "Umiak-Upload-Offset": String(u.size) } },
		);
	}

	async #headUpload(id: string): Promise<Response> {
		const up = this.#uploads.get(id);
		if (up === undefined) return new Response(null, { status: 404 });
		return new Response(null, {
			headers: { "Umiak-Upload-Offset": String(up.size) },
		});
	}

	async #deleteUpload(id: string): Promise<Response> {
		const up = this.#uploads.get(id);
		if (up === undefined) throw uploadNotFound(id);
		this.#uploads.delete(id);
		if (up.tempPath !== "") await fsp.rm(up.tempPath, { force: true });
		return new Response(null, { status: 204 });
	}

	async #commit(req: Request, id: string): Promise<Response> {
		const up = this.#uploads.get(id);
		if (up === undefined) throw uploadNotFound(id);
		if (up.commit !== null) return jsonText(up.commit);
		const raw = await readCapped(req, 64 * 1024);
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
		} catch (e) {
			throw callError("invalid_argument", `commit body: ${errorMessage(e)}`);
		}
		const p = this.resolve(typeof body.path === "string" ? body.path : "");
		let mode = 0o644;
		if (body.mode !== undefined && body.mode !== null) {
			if (
				typeof body.mode !== "number" ||
				body.mode < 0 ||
				body.mode > 0o7777
			) {
				throw callError("invalid_argument", "mode is out of range");
			}
			mode = body.mode;
		}
		const overwrite = body.overwrite !== false;
		const makeParents = (body.make_parents ?? body.makeParents) !== false;
		if (typeof body.sha256 === "string" && body.sha256 !== "") {
			const got = sha256Hex(await fsp.readFile(up.tempPath));
			if (got !== body.sha256.toLowerCase()) {
				this.#uploads.delete(id);
				await fsp.rm(up.tempPath, { force: true });
				throw callError("checksum_mismatch", `sha256 of the upload is ${got}`);
			}
		}
		const target = await prepareTarget(p, overwrite, makeParents);
		await fsCall(() => fsp.chmod(up.tempPath, mode));
		await fsCall(() => fsp.rename(up.tempPath, target));
		up.tempPath = "";
		up.commit = JSON.stringify(agentFileInfoJson(await fileInfo(p, true)));
		return jsonText(up.commit);
	}

	async #archiveGet(url: URL): Promise<Response> {
		const q = url.searchParams;
		const root = this.resolve(q.get("path") ?? "");
		const gz = parseFormat(q.get("format"));
		const st = await fsCall(() => fsp.stat(root.host));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${root.guest} is not a directory`);
		}
		const real = await fsp.realpath(root.host);
		const names = (await fsp.readdir(real)).sort();
		const contentType = gz ? "application/gzip" : "application/x-tar";
		let tar: Readable;
		if (names.length === 0) {
			tar = Readable.from([Buffer.alloc(1024)]);
		} else {
			const child = spawn(
				"tar",
				["-c", "-f", "-", "--format=pax", "-C", real, "--", ...names],
				{
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, COPYFILE_DISABLE: "1" },
				},
			);
			this.#tars.add(child);
			const out = new PassThrough();
			let stderr = "";
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.stdout.pipe(out, { end: false });
			child.on("error", (e) => {
				this.#tars.delete(child);
				out.destroy(e);
			});
			child.on("close", (code) => {
				this.#tars.delete(child);
				// A failed walk ends the body without tar's end blocks.
				if (code === 0) out.end();
				else out.destroy(new Error(`tar: ${stderr.trim()}`));
			});
			tar = out;
		}
		const body: Readable = gz ? tar.pipe(createGzip()) : tar;
		return new Response(nodeToWeb(body), {
			headers: { "Content-Type": contentType },
		});
	}

	async #archivePut(req: Request, url: URL): Promise<Response> {
		try {
			return await this.#unpack(req, url);
		} catch (e) {
			return errorResponse(e, { entries_written: 0 });
		}
	}

	async #unpack(req: Request, url: URL): Promise<Response> {
		const q = url.searchParams;
		const root = this.resolve(q.get("path") ?? "");
		const gz = parseFormat(q.get("format"));
		const overwrite = queryBool(q, "overwrite", true);
		const makeParents = queryBool(q, "make_parents", true);
		if (makeParents) {
			await fsCall(() => fsp.mkdir(root.host, { recursive: true }));
		}
		const st = await fsCall(() => fsp.stat(root.host));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${root.guest} is not a directory`);
		}
		const dir = await fsp.realpath(root.host);
		const spooled = join(this.#spool, `archive-${randomUUID()}.tar`);
		try {
			const source =
				req.body === null
					? Readable.from([])
					: Readable.fromWeb(req.body as NodeReadableStream);
			try {
				if (gz) {
					await pipeline(source, createGunzip(), createWriteStream(spooled));
				} else {
					await pipeline(source, createWriteStream(spooled));
				}
			} catch (e) {
				throw callError("invalid_argument", `read archive: ${errorMessage(e)}`);
			}
			const entries = await readTarEntries(spooled).catch((e: unknown) => {
				if (e instanceof TarFormatError) {
					throw callError("invalid_argument", `read archive: ${e.message}`);
				}
				throw e;
			});
			const result = await this.#checkEntries(entries, dir, overwrite);
			if (result.entries > 0) {
				await this.#extract(spooled, dir);
				await dropSetId(entries, dir);
			}
			return Response.json({ path: root.guest, ...result });
		} finally {
			await fsp.rm(spooled, { force: true });
		}
	}

	/** S3 §11.2 rules; the archive is extracted only if every entry passes. */
	async #checkEntries(
		entries: TarEntry[],
		root: string,
		overwrite: boolean,
	): Promise<{ entries: number; size: number }> {
		const lim = this.#limits;
		const archived = new Map<string, string>();
		let count = 0;
		let size = 0;
		for (const e of entries) {
			if (count >= lim.archiveMaxEntries) {
				throw callError(
					"payload_too_large",
					`the archive has more than ${lim.archiveMaxEntries} entries`,
				);
			}
			if (Buffer.byteLength(e.name) > lim.archiveMaxPath) {
				throw callError(
					"payload_too_large",
					`a path is longer than ${lim.archiveMaxPath} bytes`,
				);
			}
			const comps = entryComponents(e.name);
			if (comps.length === 0) continue; // the root directory itself
			const rel = comps.join("/");
			if (e.type === "3" || e.type === "4" || e.type === "6") {
				throw callError(
					"invalid_path",
					`${e.name}: devices and FIFOs are not allowed`,
				);
			}
			if (!["0", "7", "1", "2", "5"].includes(e.type)) {
				throw callError(
					"invalid_argument",
					`${e.name}: unsupported entry type ${JSON.stringify(e.type)}`,
				);
			}
			if (e.type === "1") {
				const target = entryComponents(e.linkname).join("/");
				const kind = archived.get(target);
				if (target === "" || (kind !== "0" && kind !== "7")) {
					throw callError(
						"invalid_path",
						`${e.name}: hard link to ${e.linkname} outside the archive`,
					);
				}
			}
			for (let i = 1; i < comps.length; i++) {
				const prefix = comps.slice(0, i).join("/");
				const kind = archived.get(prefix);
				const onDisk = await fsp.lstat(join(root, prefix)).catch(() => null);
				if (kind === "2" || (kind === undefined && onDisk?.isSymbolicLink())) {
					throw callError(
						"invalid_path",
						`${e.name}: passes through the symlink ${prefix}`,
					);
				}
			}
			const existing = await fsp.lstat(join(root, rel)).catch(() => null);
			if (existing !== null && !archived.has(rel)) {
				if (e.type === "5" && existing.isSymbolicLink()) {
					throw callError("invalid_path", `${e.name}: is a symlink on disk`);
				}
				if (e.type !== "5" && !overwrite) {
					throw callError("already_exists", `${rel} already exists`);
				}
			}
			archived.set(rel, e.type);
			count++;
			if (e.type === "0" || e.type === "7") {
				size += e.size;
				if (size > lim.archiveMaxBytes) {
					throw callError(
						"payload_too_large",
						`the archive unpacks to more than ${lim.archiveMaxBytes} bytes`,
					);
				}
			}
		}
		return { entries: count, size };
	}

	#extract(file: string, root: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				"tar",
				["-x", "-p", "-f", file, "-C", root, "--no-same-owner"],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			this.#tars.add(child);
			let stderr = "";
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.on("error", (e) => {
				this.#tars.delete(child);
				reject(e);
			});
			child.on("close", (code) => {
				this.#tars.delete(child);
				if (code === 0) resolve();
				else reject(callError("internal", `tar: ${stderr.trim()}`));
			});
		});
	}
}

// --- errors (shared with fake-agent.ts) ---

/** HTTP status of an agent code on `/files` (S3 §11.1, Connect mapping). */
const HTTP_STATUS: Record<string, number> = {
	path_not_found: 404,
	upload_not_found: 404,
	command_not_found: 404,
	not_found: 404,
	already_exists: 409,
	upload_offset_mismatch: 409,
	not_directory: 400,
	is_directory: 400,
	cross_device: 400,
	failed_precondition: 400,
	invalid_argument: 400,
	invalid_path: 400,
	permission_denied: 403,
	payload_too_large: 413,
	checksum_mismatch: 422,
	too_many_commands: 429,
	command_exited: 400,
	no_space: 507,
};

export function callError(
	code: string,
	message: string,
	details: Record<string, unknown> = {},
	status?: number,
): AgentCallError {
	return new AgentCallError(
		code,
		message,
		details,
		status ?? HTTP_STATUS[code] ?? 500,
	);
}

const ERRNO_CODES: Record<string, string> = {
	ENOENT: "path_not_found",
	EEXIST: "already_exists",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	ENOSPC: "no_space",
	EDQUOT: "no_space",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	EXDEV: "cross_device",
	ENOTEMPTY: "failed_precondition",
};

function errnoOf(e: unknown): string | undefined {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** A filesystem error as the agent reports it. */
function fsError(e: unknown): AgentCallError {
	if (e instanceof AgentCallError) return e;
	const code = ERRNO_CODES[errnoOf(e) ?? ""] ?? "internal";
	return callError(code, errorMessage(e));
}

async function fsCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw fsError(e);
	}
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function errorResponse(
	e: unknown,
	extra: Record<string, unknown> = {},
): Response {
	const err = fsError(e);
	const headers: Record<string, string> = {};
	if (typeof err.details.offset === "number") {
		headers["Umiak-Upload-Offset"] = String(err.details.offset);
	}
	return Response.json(
		{ ...extra, code: err.code, message: err.message, retryable: false },
		{ status: err.status ?? 500, headers },
	);
}

function endpointNotFound(): Response {
	return Response.json(
		{ code: "not_found", message: "no such endpoint", retryable: false },
		{ status: 404 },
	);
}

function methodNotAllowed(allow: string): Response {
	return Response.json(
		{ code: "unimplemented", message: "method not allowed", retryable: false },
		{ status: 405, headers: { Allow: allow } },
	);
}

function uploadNotFound(id: string): AgentCallError {
	return callError(
		"upload_not_found",
		`upload ${JSON.stringify(id)} not found`,
	);
}

function offsetMismatch(want: number, got: number): AgentCallError {
	return callError(
		"upload_offset_mismatch",
		`offset ${got} does not match the upload size ${want}`,
		{ offset: want },
	);
}

function chunkTooLarge(max: number): AgentCallError {
	return callError("payload_too_large", `a chunk is at most ${max} bytes`);
}

// --- helpers ---

const myUid = process.getuid?.() ?? -1;
const myGid = process.getgid?.() ?? -1;
const myName = userInfo().username;

async function fileInfo(p: GuestPath, follow: boolean): Promise<AgentFileInfo> {
	const st = follow ? await fsp.stat(p.host) : await fsp.lstat(p.host);
	const symlink = st.isSymbolicLink();
	return {
		path: p.guest,
		name: p.guest === "/" ? "/" : (p.guest.split("/").at(-1) ?? ""),
		type: st.isFile()
			? "file"
			: st.isDirectory()
				? "dir"
				: symlink
					? "symlink"
					: "other",
		size: st.size,
		mode: st.mode & 0o7777,
		owner: st.uid === myUid ? myName : String(st.uid),
		group: st.gid === myGid ? myName : String(st.gid),
		uid: st.uid,
		gid: st.gid,
		mtime: st.mtime,
		symlinkTarget: symlink ? await fsp.readlink(p.host) : "",
	};
}

/**
 * Like the agent: follow a symlink at p (resolve() checked it stays in the
 * root), refuse a directory, make parents. Returns the host file to replace.
 */
async function prepareTarget(
	p: GuestPath,
	overwrite: boolean,
	makeParents: boolean,
): Promise<string> {
	const target = await fsp.realpath(p.host).catch(() => p.host);
	const st = await fsp.stat(target).catch((e: unknown) => {
		if (errnoOf(e) === "ENOENT") return null;
		throw fsError(e);
	});
	if (st?.isDirectory()) {
		throw callError("is_directory", `${p.guest} is a directory`);
	}
	if (st !== null && !overwrite) {
		throw callError("already_exists", `${p.guest} already exists`);
	}
	if (makeParents) {
		await fsCall(() => fsp.mkdir(dirname(target), { recursive: true }));
	}
	return target;
}

/** S3 §11.2: modes come from the archive without setuid and setgid. */
async function dropSetId(entries: TarEntry[], root: string): Promise<void> {
	for (const e of entries) {
		if ((e.mode & 0o6000) === 0 || !"057".includes(e.type)) continue;
		const p = join(root, ...entryComponents(e.name));
		const st = await fsp.lstat(p).catch(() => null);
		if (st !== null && !st.isSymbolicLink() && (st.mode & 0o6000) !== 0) {
			await fsp.chmod(p, st.mode & 0o1777);
		}
	}
}

async function writeBody(
	req: Request,
	file: string,
	mode: number,
): Promise<void> {
	const source =
		req.body === null
			? Readable.from([])
			: Readable.fromWeb(req.body as NodeReadableStream);
	await pipeline(source, createWriteStream(file, { mode, flags: "wx" }));
}

/** The whole body, or null when it exceeds max bytes. */
async function readCapped(
	req: Request,
	max: number,
): Promise<Uint8Array | null> {
	if (req.body === null) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let size = 0;
	const reader = req.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

function jsonText(body: string): Response {
	return new Response(body, {
		headers: { "Content-Type": "application/json" },
	});
}

function nodeToWeb(r: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(r) as unknown as ReadableStream<Uint8Array>;
}

function parseRange(header: string, size: number): [number, number] | null {
	const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(header.trim());
	if (m === null) return null;
	const [, a = "", b = ""] = m;
	if (a === "") {
		const n = Number(b);
		if (b === "" || n === 0 || size === 0) return null;
		return [Math.max(0, size - n), size - 1];
	}
	const start = Number(a);
	if (start >= size) return null;
	const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	return end < start ? null : [start, end];
}

function parseMode(s: string | null): number | undefined {
	if (s === null) return undefined;
	const t = s.replace(/^0[oO]/, "");
	if (!/^[0-7]{1,6}$/.test(t) || Number.parseInt(t, 8) > 0o7777) {
		throw callError(
			"invalid_argument",
			`mode ${JSON.stringify(s)} is not an octal mode`,
		);
	}
	return Number.parseInt(t, 8);
}

function queryBool(q: URLSearchParams, key: string, def: boolean): boolean {
	const v = q.get(key);
	if (v === null) return def;
	if (["1", "t", "T", "true", "TRUE", "True"].includes(v)) return true;
	if (["0", "f", "F", "false", "FALSE", "False"].includes(v)) return false;
	throw callError(
		"invalid_argument",
		`${key}=${JSON.stringify(v)} is not a boolean`,
	);
}

function parseFormat(f: string | null): boolean {
	if (f === null || f === "" || f === "tar") return false;
	if (f === "tar.gz") return true;
	throw callError(
		"invalid_argument",
		`format ${JSON.stringify(f)} is not tar or tar.gz`,
	);
}

/** Path components of a tar entry name; absolute or ".." → invalid_path. */
function entryComponents(name: string): string[] {
	if (name.startsWith("/")) {
		throw callError("invalid_path", `${name}: absolute paths are not allowed`);
	}
	const comps = name.split("/").filter((c) => c !== "" && c !== ".");
	if (comps.includes("..")) {
		throw callError("invalid_path", `${name}: ".." is not allowed`);
	}
	return comps;
}

function compareComponents(a: string[], b: string[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i] as string;
		const y = b[i] as string;
		if (x !== y) return x < y ? -1 : 1;
	}
	return a.length - b.length;
}

export function sha256Hex(b: string | Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}
