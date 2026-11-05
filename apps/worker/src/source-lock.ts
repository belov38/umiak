import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerCtx } from "./context.ts";

const sourceScopes = new AsyncLocalStorage<Set<WorkerCtx["pool"]>>();
const sourcePermits = new WeakMap<
	WorkerCtx["pool"],
	{ active: number; waiters: (() => void)[] }
>();
export async function withSourceLock<T>(
	ctx: WorkerCtx,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const scope = sourceScopes.getStore();
	if (scope?.has(ctx.pool)) return sourceLockInner(ctx, key, fn);
	const max = ctx.pool.options.max ?? 20;
	if (max < 6)
		throw new Error(
			"source operations require a database pool of at least six connections",
		);
	const cap = Math.max(1, Math.floor((max - 2) / 4));
	let permits = sourcePermits.get(ctx.pool);
	if (!permits) {
		permits = { active: 0, waiters: [] };
		sourcePermits.set(ctx.pool, permits);
	}
	if (permits.active >= cap)
		await new Promise<void>((resolve) => permits.waiters.push(resolve));
	else permits.active++;
	const nested = new Set(scope);
	nested.add(ctx.pool);
	try {
		return await sourceScopes.run(nested, () => sourceLockInner(ctx, key, fn));
	} finally {
		const next = permits.waiters.shift();
		if (next) next();
		else permits.active--;
	}
}
async function sourceLockInner<T>(
	ctx: WorkerCtx,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const client = await ctx.pool.connect();
	let lost = false;
	const onError = () => {
		lost = true;
	};
	client.on("error", onError);
	try {
		await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
			`portable:${key}`,
		]);
		const result = await fn();
		if (lost) throw new Error("source operation lost its lock connection");
		return result;
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
				`portable:${key}`,
			]);
			client.removeListener("error", onError);
			client.release();
		} catch {
			client.removeListener("error", onError);
			client.release(true);
		}
	}
}
