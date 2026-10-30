// The filesystem of one fake sandbox: a directory of the host mapped to the
// guest's `/`. Absolute paths and paths relative to `/home/user` (also `~`)
// are resolved inside it; symlinks are followed by hand so that an absolute
// link target stays inside the root and never reaches the host.
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeApiError, invalidState } from "./errors.ts";

export const HOME = "/home/user";
const MAX_SYMLINK_HOPS = 40;

export interface FileInfoJson {
	path: string;
	name: string;
	type: "file" | "dir" | "symlink" | "other";
	sizeBytes: number;
	mode: number;
	owner: string;
	group: string;
	uid: number;
	gid: number;
	modifiedAt: string | null;
	symlinkTarget: string | null;
}

interface Resolved {
	/** Path on the host. */
	host: string;
	/** Normalized guest path. */
	virtual: string;
	exists: boolean;
}

export interface PathOptions {
	/** Home directory that relative paths start from (default /home/user). */
	home?: string;
	/** Follow a symlink in the last segment (default true). */
	follow?: boolean;
}

function split(path: string): string[] {
	return path.split("/").filter((s) => s !== "" && s !== ".");
}

function absolute(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
	if (path.startsWith("/")) return path;
	return `${home}/${path}`;
}

export function pathNotFound(path: string): FakeApiError {
	return new FakeApiError(404, "path_not_found", `no such path: ${path}`);
}

export class SandboxFs {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	async init(): Promise<void> {
		await mkdir(join(this.root, HOME), { recursive: true });
	}

	async resolve(input: string, o: PathOptions = {}): Promise<Resolved> {
		const follow = o.follow ?? true;
		let pending = split(absolute(input, o.home ?? HOME));
		const done: string[] = [];
		let hops = 0;
		while (pending.length > 0) {
			const seg = pending.shift() as string;
			if (seg === "..") {
				done.pop();
				continue;
			}
			const host = join(this.root, ...done, seg);
			let st: Awaited<ReturnType<typeof lstat>>;
			try {
				st = await lstat(host);
			} catch {
				// The rest does not exist either: normalize it lexically.
				done.push(seg);
				for (const s of pending) {
					if (s === "..") done.pop();
					else done.push(s);
				}
				return {
					host: join(this.root, ...done),
					virtual: `/${done.join("/")}`,
					exists: false,
				};
			}
			if (st.isSymbolicLink() && (pending.length > 0 || follow)) {
				if (++hops > MAX_SYMLINK_HOPS) {
					throw new FakeApiError(
						400,
						"invalid_path",
						`too many levels of symbolic links: ${input}`,
					);
				}
				const target = await readlink(host);
				if (target.startsWith("/")) done.length = 0;
				pending = [...split(target), ...pending];
				continue;
			}
			done.push(seg);
		}
		return {
			host: join(this.root, ...done),
			virtual: `/${done.join("/")}`,
			exists: true,
		};
	}

	/** FileInfo of a path or null when missing. */
	async stat(input: string, o: PathOptions = {}): Promise<FileInfoJson | null> {
		const follow = o.follow ?? true;
		const link = await this.resolve(input, { ...o, follow: false });
		if (!link.exists) return null;
		const l = await lstat(link.host);
		if (!l.isSymbolicLink()) return infoOf(link.virtual, l, null);
		const target = await readlink(link.host);
		if (!follow) return infoOf(link.virtual, l, target);
		const real = await this.resolve(input, o);
		if (!real.exists) return null;
		return infoOf(link.virtual, await stat(real.host), target);
	}

	/** Entries under `path` down to `depth` levels, ordered by path. */
	async list(
		input: string,
		o: PathOptions & { depth: number; includeHidden: boolean },
	): Promise<FileInfoJson[]> {
		const dir = await this.resolve(input, o);
		if (!dir.exists) throw pathNotFound(input);
		if (!(await stat(dir.host)).isDirectory()) {
			throw new FakeApiError(
				409,
				"not_directory",
				`${input} is not a directory`,
			);
		}
		const out: FileInfoJson[] = [];
		const walk = async (host: string, virtual: string, level: number) => {
			for (const name of await readdir(host)) {
				if (!o.includeHidden && name.startsWith(".")) continue;
				const h = join(host, name);
				const v = virtual === "/" ? `/${name}` : `${virtual}/${name}`;
				const l = await lstat(h);
				const target = l.isSymbolicLink() ? await readlink(h) : null;
				out.push(infoOf(v, l, target));
				if (l.isDirectory() && level < o.depth) await walk(h, v, level + 1);
			}
		};
		await walk(dir.host, dir.virtual, 1);
		return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	async read(input: string, o: PathOptions = {}): Promise<Buffer> {
		const r = await this.resolve(input, o);
		if (!r.exists) throw pathNotFound(input);
		if ((await stat(r.host)).isDirectory()) {
			throw new FakeApiError(409, "is_directory", `${input} is a directory`);
		}
		return readFile(r.host);
	}

	/** Atomic write: a temporary file next to the target, then rename. */
	async write(
		input: string,
		data: Uint8Array | string,
		o: PathOptions & {
			mode?: number;
			makeParents?: boolean;
			overwrite?: boolean;
			mtime?: Date;
		} = {},
	): Promise<FileInfoJson> {
		const r = await this.resolve(input, o);
		if (r.exists) {
			if ((await stat(r.host)).isDirectory()) {
				throw new FakeApiError(409, "is_directory", `${input} is a directory`);
			}
			if (o.overwrite === false) {
				throw new FakeApiError(409, "already_exists", `${input} exists`);
			}
		} else if (o.makeParents === false) {
			const parent = await this.resolve(dirname(r.virtual), o);
			if (!parent.exists) throw pathNotFound(dirname(r.virtual));
		}
		await mkdir(dirname(r.host), { recursive: true });
		const tmp = `${r.host}.sbx-tmp-${process.pid}`;
		await writeFile(tmp, data);
		if (o.mode !== undefined) await chmod(tmp, o.mode);
		if (o.mtime) await utimes(tmp, o.mtime, o.mtime);
		await rename(tmp, r.host);
		const info = await this.stat(r.virtual, { follow: false });
		return info as FileInfoJson;
	}

	async mkdir(input: string, o: PathOptions = {}): Promise<void> {
		const r = await this.resolve(input, o);
		await mkdir(r.host, { recursive: true });
	}

	/** Creates a symlink at `input` pointing at `target` (kept as written). */
	async symlink(
		input: string,
		target: string,
		o: PathOptions = {},
	): Promise<void> {
		const r = await this.resolve(input, { ...o, follow: false });
		await mkdir(dirname(r.host), { recursive: true });
		await symlink(target, r.host);
	}

	async utimes(input: string, mtime: Date): Promise<void> {
		const r = await this.resolve(input);
		await utimes(r.host, mtime, mtime);
	}

	/** Removes a path; false when it did not exist. */
	async remove(
		input: string,
		recursive: boolean,
		o: PathOptions = {},
	): Promise<boolean> {
		const r = await this.resolve(input, { ...o, follow: false });
		if (!r.exists) return false;
		const l = await lstat(r.host);
		if (l.isDirectory() && !recursive && (await readdir(r.host)).length > 0) {
			throw invalidState(`${input} is not empty; pass recursive=true`, {
				reason: "not_empty",
			});
		}
		await rm(r.host, { recursive: true, force: true });
		return true;
	}

	async readText(input: string): Promise<string> {
		return (await this.read(input)).toString("utf8");
	}
}

function infoOf(
	path: string,
	st: Awaited<ReturnType<typeof lstat>>,
	symlinkTarget: string | null,
): FileInfoJson {
	const type = st.isSymbolicLink()
		? "symlink"
		: st.isDirectory()
			? "dir"
			: st.isFile()
				? "file"
				: "other";
	const name = path === "/" ? "" : (path.split("/").pop() as string);
	return {
		path,
		name,
		type,
		sizeBytes: Number(st.size),
		mode: Number(st.mode) & 0o7777,
		owner: "user",
		group: "user",
		uid: 1000,
		gid: 1000,
		modifiedAt: new Date(Number(st.mtimeMs)).toISOString(),
		symlinkTarget,
	};
}
