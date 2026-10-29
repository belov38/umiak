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
	/**
	 * Capabilities reported by the agent (Control/Info); null while unknown
	 * (after a reconnect of a new agent process or version, before Info).
	 */
	capabilities: string[] | null;
}

/**
 * Thrown by Registry.lookup after close(). It is terminal: the routing loop
 * does not treat it as a miss and does not wait for the registry.
 */
export class RegistryClosedError extends Error {
	constructor() {
		super("registry is closed");
		this.name = "RegistryClosedError";
	}
}

/** Looks up the gateway instance that serves a machine. */
export interface Registry {
	/**
	 * Returns the current route, or undefined when the machine is not
	 * connected. Throws RegistryClosedError after close().
	 */
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
