// Fault injection over any port object. The wrapped object is a Proxy; method
// calls run on the original target, so private fields keep working.

/** A pod died: thrown after (or before) a side effect, nothing else runs. */
export class SimulatedCrash extends Error {
	/** The job is redelivered, like after a real crash. */
	readonly retryable = true;
	constructor(method: string, when: "after" | "before", nth: number) {
		super(`simulated crash ${when} call ${nth} of ${method}`);
		this.name = "SimulatedCrash";
	}
}

type AnyFn = (...args: unknown[]) => unknown;

function wrapMethod<T extends object>(
	target: T,
	method: keyof T,
	wrap: (orig: AnyFn) => AnyFn,
): T {
	const orig = Reflect.get(target, method, target);
	if (typeof orig !== "function") {
		throw new Error(`${String(method)} is not a method`);
	}
	const wrapped = wrap((...args: unknown[]) =>
		(orig as AnyFn).apply(target, args),
	);
	return new Proxy(target, {
		get(t, p) {
			if (p === method) return wrapped;
			const v = Reflect.get(t, p, t);
			return typeof v === "function" ? (v as AnyFn).bind(t) : v;
		},
	});
}

/**
 * After the `nth` successful call of `method` the call's effect is done, but
 * the caller gets `SimulatedCrash` instead of the result. Other calls pass.
 */
export function crashAfter<T extends object>(
	target: T,
	method: keyof T,
	nth = 1,
): T {
	let ok = 0;
	return wrapMethod(target, method, (orig) => async (...args) => {
		const r = await orig(...args);
		ok += 1;
		if (ok === nth) throw new SimulatedCrash(String(method), "after", nth);
		return r;
	});
}

/** The `nth` call of `method` throws `SimulatedCrash` without doing anything. */
export function crashBefore<T extends object>(
	target: T,
	method: keyof T,
	nth = 1,
): T {
	let calls = 0;
	return wrapMethod(target, method, (orig) => async (...args) => {
		calls += 1;
		if (calls === nth) throw new SimulatedCrash(String(method), "before", nth);
		return orig(...args);
	});
}

export interface Blocked<T> {
	/** The wrapped port. */
	port: T;
	/** Resolves when the first call has done its effect and is held. */
	reached: Promise<void>;
	/** Lets the held call return. */
	release(): void;
}

/**
 * The first call of `method` does its effect, then waits for `release()`
 * before returning (an executor stuck inside a Proxmox call). Later calls
 * pass through.
 */
export function blockAfter<T extends object>(
	target: T,
	method: keyof T,
): Blocked<T> {
	let reachedResolve: () => void = () => {};
	let releaseResolve: () => void = () => {};
	const reached = new Promise<void>((r) => {
		reachedResolve = r;
	});
	const released = new Promise<void>((r) => {
		releaseResolve = r;
	});
	let first = true;
	const port = wrapMethod(target, method, (orig) => async (...args) => {
		const r = await orig(...args);
		if (first) {
			first = false;
			reachedResolve();
			await released;
		}
		return r;
	});
	return { port, reached, release: () => releaseResolve() };
}

/**
 * The first call of `method` waits for `release()` before doing anything (an
 * executor that passed its fence check and is stuck on the way into a
 * Proxmox call). Later calls pass through.
 */
export function blockBefore<T extends object>(
	target: T,
	method: keyof T,
): Blocked<T> {
	let reachedResolve: () => void = () => {};
	let releaseResolve: () => void = () => {};
	const reached = new Promise<void>((r) => {
		reachedResolve = r;
	});
	const released = new Promise<void>((r) => {
		releaseResolve = r;
	});
	let first = true;
	const port = wrapMethod(target, method, (orig) => async (...args) => {
		if (first) {
			first = false;
			reachedResolve();
			await released;
		}
		return orig(...args);
	});
	return { port, reached, release: () => releaseResolve() };
}

/** Records every call of `method` and runs `spy` before it (to observe state at call time). */
export function spyBefore<T extends object>(
	target: T,
	method: keyof T,
	spy: (...args: unknown[]) => Promise<void>,
): T {
	return wrapMethod(target, method, (orig) => async (...args) => {
		await spy(...args);
		return orig(...args);
	});
}
