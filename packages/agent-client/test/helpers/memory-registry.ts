import type { Registry, Route } from "../../src/index.js";

/** In-memory Registry for transport and fetch tests. */
export class MemoryRegistry implements Registry {
	readonly routes = new Map<string, Route>();
	lookups = 0;
	readonly invalidations: string[] = [];
	private readonly waiters = new Set<() => void>();

	/** Sets (or replaces) the route of a machine and wakes waiters. */
	set(route: Route): void {
		this.routes.set(route.machineId, route);
		this.wake();
	}

	/** Removes the route of a machine and wakes waiters. */
	delete(machineId: string): void {
		this.routes.delete(machineId);
		this.wake();
	}

	async lookup(machineId: string): Promise<Route | undefined> {
		this.lookups++;
		return this.routes.get(machineId);
	}

	invalidate(machineId: string): void {
		this.invalidations.push(machineId);
	}

	waitForChange(
		_machineId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			this.waiters.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	async close(): Promise<void> {
		this.wake();
	}

	private wake(): void {
		for (const w of [...this.waiters]) {
			w();
		}
	}
}

/** Builds a Route with defaults for tests. */
export function route(
	machineId: string,
	internalUrl: string,
	opts: Partial<Route> = {},
): Route {
	return {
		machineId,
		instanceId: opts.instanceId ?? internalUrl,
		internalUrl,
		epoch: opts.epoch ?? 1n,
		capabilities: opts.capabilities ?? [],
	};
}
