import { CliError, NOT_LOGGED_IN } from "../exit-codes.ts";
import { apiError, deadline, type Fetch, send } from "../http.ts";

export interface PairCode {
	id: string;
	code?: string | undefined;
	verificationUri: string;
	expiresIn: number;
}

/** Pair only with this deployment; polling secrets never appear in browser URLs. */
export async function ownerLogin(options: {
	apiUrl: string;
	fetch: Fetch;
	onCode: (code: PairCode) => void;
	sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
	const origin = new URL(options.apiUrl).origin;
	async function post(
		path: string,
		body: unknown,
	): Promise<Record<string, unknown>> {
		const limit = deadline(20000);
		try {
			const res = await send(
				options.fetch,
				new Request(`${origin}${path}`, {
					method: "POST",
					redirect: "error",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: limit.signal,
				}),
				limit.signal,
			);
			if (!res.ok) throw await apiError(res);
			return (await res.json()) as Record<string, unknown>;
		} finally {
			limit.clear();
		}
	}
	const pair = await post("/owner/pair", {});
	if (
		typeof pair.id !== "string" ||
		typeof pair.secret !== "string" ||
		typeof pair.expiresIn !== "number" ||
		pair.expiresIn <= 0 ||
		pair.expiresIn > 600
	) {
		throw new CliError({
			code: NOT_LOGGED_IN,
			message: "Invalid owner pairing response",
			retryable: false,
		});
	}
	options.onCode({
		id: pair.id,
		code: typeof pair.code === "string" ? pair.code : undefined,
		verificationUri: `${origin}/owner/pair?id=${encodeURIComponent(pair.id)}`,
		expiresIn: pair.expiresIn,
	});
	const end = Date.now() + pair.expiresIn * 1000;
	const interval =
		Math.max(
			0,
			Math.min(typeof pair.interval === "number" ? pair.interval : 2, 10),
		) * 1000;
	const sleep =
		options.sleep ??
		((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	while (Date.now() < end) {
		await sleep(interval);
		const result = await post("/owner/pair/poll", {
			id: pair.id,
			secret: pair.secret,
		});
		if (typeof result.token === "string" && result.token.length > 0)
			return result.token;
		if (result.pending !== true) break;
	}
	throw new CliError({
		code: NOT_LOGGED_IN,
		message: "Owner pairing expired; run umiak login again",
		retryable: false,
	});
}
