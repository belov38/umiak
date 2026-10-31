/**
 * Runs fn with an AbortSignal that the first SIGINT/SIGTERM aborts, so the run can stop and clean
 * up what it made; the second signal exits at once.
 */
export async function withAbortSignals<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	log: (text: string) => void = (s) => process.stderr.write(`${s}\n`),
): Promise<T> {
	const ac = new AbortController();
	const onSignal = (name: NodeJS.Signals) => {
		if (ac.signal.aborted) {
			log(`${name}: second signal, exiting without cleanup`);
			process.exit(130);
		}
		log(`${name}: stopping, cleaning up (send it again to exit at once)`);
		ac.abort(new Error(`interrupted by ${name}`));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		return await fn(ac.signal);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

/** Rejects as soon as the signal aborts; the promise itself keeps running. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() =>
			signal.removeEventListener("abort", onAbort),
		);
	});
}
