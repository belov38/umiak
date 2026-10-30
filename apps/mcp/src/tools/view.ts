// Small helpers shared by the tools: API camelCase -> model snake_case, and
// request bodies without undefined fields.

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function snakeCase(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Deep key rename. Only for structures with fixed keys: dictionaries with
 * free keys (labels, env) must not go through it.
 */
export function snakeKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(snakeKeys);
	if (!isPlainObject(v)) return v;
	return Object.fromEntries(
		Object.entries(v).map(([k, x]) => [snakeCase(k), snakeKeys(x)]),
	);
}

/** The object without the fields that are `undefined` (the API rejects `null` where absent is meant). */
export function compact<T extends Record<string, unknown>>(
	o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(
		Object.entries(o).filter(([, v]) => v !== undefined),
	) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
