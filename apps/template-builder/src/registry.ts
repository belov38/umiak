import { randomUUIDv7 } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest.ts";

// Build registry as JSON files, one manifest per build (plan S5, decision 3)

const ID_RE = /^[0-9a-f-]{1,64}$/;
const VERSION_RE = /^(\d{8})\.(\d+)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CLAIM_SUFFIX = ".claim";

export function newBuildId(): string {
	return randomUUIDv7();
}

function utcDate(now: Date): string {
	return now.toISOString().slice(0, 10).replaceAll("-", "");
}

export class FileRegistry {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	#file(id: string): string {
		if (!ID_RE.test(id)) throw new Error(`invalid build id "${id}"`);
		return join(this.dir, `${id}.json`);
	}

	/** Temp file in the same directory, then rename: readers never see a partial manifest. */
	#write(m: Manifest): void {
		mkdirSync(this.dir, { recursive: true });
		const file = this.#file(m.buildId);
		const tmp = join(this.dir, `.tmp-${m.buildId}-${process.pid}.json`);
		writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
		renameSync(tmp, file);
	}

	create(m: Manifest): void {
		if (existsSync(this.#file(m.buildId)))
			throw new Error(`build ${m.buildId} already exists`);
		const same = this.list(m.templateSlug).find((x) => x.version === m.version);
		if (same)
			throw new Error(
				`build ${same.buildId} already has ${m.templateSlug} ${m.version}`,
			);
		this.#write(m);
	}

	/** Merges `patch` and drops the fields in `unset`. */
	update(
		id: string,
		patch: Partial<Manifest>,
		unset: (keyof Manifest)[] = [],
	): Manifest {
		const cur = this.get(id);
		if (!cur) throw new Error(`build ${id} not found`);
		const next: Partial<Manifest> = { ...cur, ...patch, buildId: cur.buildId };
		for (const k of unset) if (k !== "buildId") delete next[k];
		this.#write(next as Manifest);
		return next as Manifest;
	}

	get(id: string): Manifest | undefined {
		const file = this.#file(id);
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8")) as Manifest;
	}

	/** Builds of `slug` (all when omitted), oldest first. */
	list(slug?: string): Manifest[] {
		if (!existsSync(this.dir)) return [];
		const out: Manifest[] = [];
		for (const name of readdirSync(this.dir)) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : "";
			if (!ID_RE.test(id)) continue;
			const m = this.get(id);
			if (m && (slug === undefined || m.templateSlug === slug)) out.push(m);
		}
		return out.sort(
			(a, b) =>
				a.startedAt.localeCompare(b.startedAt) ||
				a.buildId.localeCompare(b.buildId),
		);
	}

	#claimFile(slug: string, version: string): string {
		if (!SLUG_RE.test(slug)) throw new Error(`invalid template slug "${slug}"`);
		return join(this.dir, `${slug}@${version}${CLAIM_SUFFIX}`);
	}

	/**
	 * `<YYYYMMDD UTC>.<n>`: n is one more than the highest n of that day for the slug, over
	 * manifests and version claims.
	 */
	nextVersion(slug: string, now: Date): string {
		const day = utcDate(now);
		const versions = this.list(slug).map((m) => m.version);
		if (existsSync(this.dir)) {
			const prefix = `${slug}@`;
			for (const name of readdirSync(this.dir))
				if (name.startsWith(prefix) && name.endsWith(CLAIM_SUFFIX))
					versions.push(name.slice(prefix.length, -CLAIM_SUFFIX.length));
		}
		let max = 0;
		for (const version of versions) {
			const v = VERSION_RE.exec(version);
			if (v?.[1] === day) max = Math.max(max, Number(v[2]));
		}
		return `${day}.${max + 1}`;
	}

	/**
	 * Reserves the next version for a new build. The claim file is created exclusively, so two
	 * concurrent builds never get the same version; a lost race moves on to the next n.
	 */
	claimVersion(slug: string, now: Date): string {
		mkdirSync(this.dir, { recursive: true });
		const v = VERSION_RE.exec(this.nextVersion(slug, now));
		if (!v) throw new Error("nextVersion returned a malformed version");
		for (let n = Number(v[2]); ; n++) {
			const version = `${v[1]}.${n}`;
			try {
				closeSync(openSync(this.#claimFile(slug, version), "wx"));
				return version;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
		}
	}
}
