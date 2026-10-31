// Files (S7 §11.1): content with Range, write, stat, list, delete. The files
// are real files under the sandbox's directory (vfs.ts).
import type { Context } from "hono";
import { FakeApiError } from "./errors.ts";
import {
	limitOf,
	lookupSandbox,
	paginate,
	requireReady,
	sandboxParam,
} from "./model.ts";
import type { Fake, FakeApp, FakeEnv, FakeSandbox } from "./state.ts";
import { HOME, type PathOptions, pathNotFound } from "./vfs.ts";

function homeOf(user: string | undefined): string {
	if (user === undefined || user === "user") return HOME;
	return user === "root" ? "/root" : `/home/${user}`;
}

function pathOptions(c: Context<FakeEnv>): PathOptions {
	return { home: homeOf(c.req.query("user")) };
}

function rangeNotSatisfiable(size: number, detail: string): FakeApiError {
	return new FakeApiError(416, "range_not_satisfiable", detail, {
		headers: { "Content-Range": `bytes */${size}` },
	});
}

/** `bytes=a-b`, `a-`, `-n`: [start, end] inclusive; null for no usable single range. */
function parseRange(header: string, size: number): [number, number] | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null; // several ranges or junk: the whole file
	const [, a = "", b = ""] = m;
	if (a === "" && b === "") return null;
	let start: number;
	let end: number;
	if (a === "") {
		const n = Number(b);
		if (n === 0) throw rangeNotSatisfiable(size, "an empty suffix range");
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	}
	if (start >= size || start > end) {
		throw rangeNotSatisfiable(
			size,
			`range ${header} is outside the file (${size} bytes)`,
		);
	}
	return [start, end];
}

export function registerFileRoutes(app: FakeApp, fake: Fake): void {
	const base = "/v1/sandboxes/:sandbox/files";

	async function ready(c: Context<FakeEnv>): Promise<FakeSandbox> {
		const sb = lookupSandbox(fake, c.get("principal"), sandboxParam(c));
		await requireReady(fake, sb, c.req.raw.signal);
		return sb;
	}

	app.get(`${base}/content`, async (c) => {
		const sb = await ready(c);
		const path = c.req.query("path") as string;
		const fs = fake.state.fs(sb.id);
		const info = await fs.stat(path, pathOptions(c));
		if (!info) throw pathNotFound(path);
		const data = await fs.read(path, pathOptions(c));
		await fake.script.onFileRead?.({ sandboxId: sb.id, path });
		const etag = `"${data.length}-${Math.floor(Date.parse(info.modifiedAt ?? "0"))}"`;
		const lastModified = new Date(info.modifiedAt ?? 0).toUTCString();
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
			"X-Content-Type-Options": "nosniff",
			"Accept-Ranges": "bytes",
			ETag: etag,
			"Last-Modified": lastModified,
		};
		const rangeHeader = c.req.header("Range");
		const ifRange = c.req.header("If-Range");
		const honored =
			ifRange === undefined || ifRange === etag || ifRange === lastModified;
		const range =
			rangeHeader !== undefined && honored
				? parseRange(rangeHeader, data.length)
				: null;
		if (range === null) {
			headers["Content-Length"] = String(data.length);
			return new Response(new Uint8Array(data), { status: 200, headers });
		}
		const [start, end] = range;
		const part = data.subarray(start, end + 1);
		headers["Content-Length"] = String(part.length);
		headers["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
		return new Response(new Uint8Array(part), { status: 206, headers });
	});

	app.put(`${base}/content`, async (c) => {
		const sb = await ready(c);
		const mode = c.req.query("mode");
		const body = new Uint8Array(await c.req.arrayBuffer());
		const info = await fake.state
			.fs(sb.id)
			.write(c.req.query("path") as string, body, {
				...pathOptions(c),
				makeParents: c.req.query("makeParents") !== "false",
				overwrite: c.req.query("overwrite") !== "false",
				...(mode === undefined ? {} : { mode: Number.parseInt(mode, 8) }),
			});
		return c.json(info);
	});

	app.get(`${base}/stat`, async (c) => {
		const sb = await ready(c);
		const path = c.req.query("path") as string;
		const info = await fake.state.fs(sb.id).stat(path, {
			...pathOptions(c),
			follow: c.req.query("noFollow") !== "true",
		});
		if (!info) throw pathNotFound(path);
		return c.json(info);
	});

	app.get(`${base}/list`, async (c) => {
		const sb = await ready(c);
		const entries = await fake.state
			.fs(sb.id)
			.list(c.req.query("path") as string, {
				...pathOptions(c),
				depth: Number(c.req.query("depth") ?? 1),
				includeHidden: c.req.query("includeHidden") !== "false",
			});
		const page = paginate(entries, {
			limit: limitOf(c, 50),
			cursor: c.req.query("cursor"),
			key: (e) => e.path,
			dir: "asc",
		});
		return c.json({ data: page.data, nextCursor: page.nextCursor });
	});

	app.delete(base, async (c) => {
		const sb = await ready(c);
		const existed = await fake.state
			.fs(sb.id)
			.remove(
				c.req.query("path") as string,
				c.req.query("recursive") === "true",
				pathOptions(c),
			);
		return c.json({ existed });
	});
}
