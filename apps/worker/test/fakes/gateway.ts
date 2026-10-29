// Recording fake of the gateway internal API (S2 §5.2).
import {
	type GatewayPort,
	GatewayRejected,
	GatewayUnavailable,
} from "../../src/ports.ts";

export type GatewayFailure = "unavailable" | { rejected: string };

export class FakeGateway implements GatewayPort {
	readonly rotated: string[] = [];
	#failure: { failure: GatewayFailure; times: number } | undefined;

	/** The next `times` calls fail (`Infinity` for always). */
	fail(failure: GatewayFailure, times = 1): void {
		this.#failure = { failure, times };
	}

	async rotateToken(machineId: string): Promise<void> {
		this.rotated.push(machineId);
		const f = this.#failure;
		if (f && f.times > 0) {
			f.times -= 1;
			throw f.failure === "unavailable"
				? new GatewayUnavailable()
				: new GatewayRejected(f.failure.rejected);
		}
	}
}
