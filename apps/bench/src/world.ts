/** Inventory sections compared before and after a run (everything but the search result). */
export type World = Record<string, unknown>;

function rows(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => JSON.stringify(x)).sort();
	if (v && typeof v === "object") {
		return Object.entries(v as Record<string, unknown>)
			.flatMap(([k, x]) =>
				Array.isArray(x) || (x && typeof x === "object")
					? rows(x).map((r) => `${k}: ${r}`)
					: [`${k}: ${JSON.stringify(x)}`],
			)
			.sort();
	}
	return [JSON.stringify(v)];
}

/** Human-readable differences between two sbx-node inventories. Empty means the world is unchanged. */
export function diffWorld(before: World, after: World): string[] {
	const out: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const k of [...keys].sort()) {
		if (k === "search") continue;
		const a = new Set(rows(before[k]));
		const b = new Set(rows(after[k]));
		for (const r of a) if (!b.has(r)) out.push(`${k}: - ${r}`);
		for (const r of b) if (!a.has(r)) out.push(`${k}: + ${r}`);
	}
	return out;
}
