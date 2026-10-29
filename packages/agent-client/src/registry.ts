/** Where a machine's tunnel is served right now. */
export interface Route {
	/** Machine id (lower-case UUID). */
	machineId: string;
	/** Gateway instance id that owns the tunnel. */
	instanceId: string;
	/** Internal URL of that instance, e.g. http://10.0.0.7:8081. */
	internalUrl: string;
	/** Connection epoch of the session. */
	epoch: bigint;
	/** Capabilities reported by the agent (Control/Info). */
	capabilities: string[];
}

/** Looks up the gateway instance that serves a machine. */
export interface Registry {
	/** Returns the current route, or undefined when the machine is not connected. */
	lookup(machineId: string): Promise<Route | undefined>;
	/** Drops any cached route of the machine. */
	invalidate(machineId: string): void;
	/**
	 * Resolves when the machine's session changes (NOTIFY), after timeoutMs, or
	 * when the signal aborts, whichever comes first. Never rejects.
	 */
	waitForChange(
		machineId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void>;
	/** Releases connections and wakes all waiters. */
	close(): Promise<void>;
}

/** Same session: instance, URL and epoch match. */
export function sameRoute(a: Route, b: Route): boolean {
	return (
		a.instanceId === b.instanceId &&
		a.internalUrl === b.internalUrl &&
		a.epoch === b.epoch
	);
}
