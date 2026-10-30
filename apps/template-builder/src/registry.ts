import { randomUUIDv7 } from "node:crypto";
import {
	existsSync,
	mkdirSync,
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

	update(id: string, patch: Partial<Manifest>): Manifest {
		const cur = this.get(id);
		if (!cur) throw new Error(`build ${id} not found`);
		const next = { ...cur, ...patch, buildId: cur.buildId };
		this.#write(next);
		return next;
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

	/** `<YYYYMMDD UTC>.<n>`: n is one more than the highest n of that day for the slug. */
	nextVersion(slug: string, now: Date): string {
		const day = utcDate(now);
		let max = 0;
		for (const m of this.list(slug)) {
			const v = VERSION_RE.exec(m.version);
			if (v?.[1] === day) max = Math.max(max, Number(v[2]));
		}
		return `${day}.${max + 1}`;
	}
}
