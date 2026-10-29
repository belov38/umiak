/** Replaces every occurrence of the secrets in all strings of a JSON-like value. */
export function redact<T>(value: T, secrets: string[]): T {
	const live = secrets.filter((s) => s.length >= 4);
	const walk = (v: unknown): unknown => {
		if (typeof v === "string")
			return live.reduce((acc, s) => acc.split(s).join("<redacted>"), v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v).map(([k, x]) => [k, walk(x)]),
			);
		return v;
	};
	return walk(value) as T;
}

/** Fixed-width text table. */
export function table(header: string[], body: (string | number)[][]): string {
	const cells = [header, ...body.map((r) => r.map(String))];
	const widths = header.map((_, i) =>
		Math.max(...cells.map((r) => (r[i] ?? "").length)),
	);
	return cells
		.map((r) =>
			r
				.map((c, i) => c.padEnd(widths[i] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}
