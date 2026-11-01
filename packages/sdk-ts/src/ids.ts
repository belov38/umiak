// Idempotency keys (S7 §5.7).

/** POST routes (OpenAPI path templates) that take an Idempotency-Key. */
export const IDEMPOTENT_POSTS: ReadonlySet<string> = new Set([
	"/v1/sandboxes",
	"/v1/sandboxes/{sandbox}/fork",
	"/v1/sandboxes/{sandbox}/commands",
	"/v1/sandboxes/{sandbox}/desktop/actions",
	"/v1/sandboxes/{sandbox}/ptys",
	"/v1/snapshots",
]);

/** Whether the SDK sets an Idempotency-Key on this request when the caller did not. */
export function takesIdempotencyKey(method: string, schemaPath: string) {
	return method.toUpperCase() === "POST" && IDEMPOTENT_POSTS.has(schemaPath);
}

/** A new UUIDv4 Idempotency-Key. */
export function newIdempotencyKey(): string {
	const c = globalThis.crypto;
	// randomUUID is missing in browsers outside secure contexts.
	if (typeof c.randomUUID === "function") return c.randomUUID();
	const b = c.getRandomValues(new Uint8Array(16));
	b[6] = ((b[6] as number) & 0x0f) | 0x40;
	b[8] = ((b[8] as number) & 0x3f) | 0x80;
	const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
