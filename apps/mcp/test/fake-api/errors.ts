// Error envelope of the API (S7 §5.5), as the fake renders it:
//   {"error": {code, message, retryable, details, requestId}} + Request-Id.

export interface FakeErrorOptions {
	retryable?: boolean;
	details?: Record<string, unknown>;
	headers?: Record<string, string>;
}

export class FakeApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryable: boolean;
	readonly details: Record<string, unknown>;
	readonly headers: Record<string, string>;

	constructor(
		status: number,
		code: string,
		message: string,
		o: FakeErrorOptions = {},
	) {
		super(message);
		this.name = "FakeApiError";
		this.status = status;
		this.code = code;
		this.retryable = o.retryable ?? false;
		this.details = o.details ?? {};
		this.headers = o.headers ?? {};
	}
}

export function errorBody(e: FakeApiError, requestId: string) {
	return {
		error: {
			code: e.code,
			message: e.message,
			retryable: e.retryable,
			details: e.details,
			requestId,
		},
	};
}

export function notFound(what = "resource"): FakeApiError {
	return new FakeApiError(404, "not_found", `${what} not found`);
}

export function validation(
	issues: { path: string; message: string }[],
): FakeApiError {
	const first = issues[0];
	const message = first
		? `${first.path === "" ? "request" : first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`
		: "the request is invalid";
	return new FakeApiError(400, "validation", message, { details: { issues } });
}

export function invalidState(
	message: string,
	details: Record<string, unknown> = {},
): FakeApiError {
	return new FakeApiError(409, "invalid_state", message, { details });
}

export function forbidden(
	message: string,
	details: Record<string, unknown> = {},
): FakeApiError {
	return new FakeApiError(403, "forbidden", message, { details });
}

/** The 404 of a path the API has no route for (the real notFoundHandler). */
export function noRoute(method: string, path: string): FakeApiError {
	return new FakeApiError(404, "not_found", `no route for ${method} ${path}`);
}
