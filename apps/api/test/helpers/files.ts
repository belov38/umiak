// Helpers of the file route tests: raw requests with byte or streamed
// bodies (the harness reads answers as text), the files URL of a sandbox,
// and a minimal ustar writer for hostile archives.
import type { AgentApi } from "../../src/index.ts";
import type { Harness } from "./harness.ts";
import type { ApiWorld } from "./world.ts";

const REQUEST_ID_RE = /^req_[0-9a-z]{26}$/;

export interface RawInit {
	headers?: Record<string, string>;
	body?: BodyInit | ReadableStream<Uint8Array>;
	bearer?: string;
	signal?: AbortSignal;
}

/**
 * Sends a request through the app and returns the Response as it is
 * (streamed body). Checks the Request-Id header like the harness.
 */
export async function rawRequest(
	h: Harness,
	method: string,
	path: string,
	init: RawInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	const bearer = init.bearer ?? h.bearer;
	if (bearer !== undefined && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${bearer}`);
	}
	const req: RequestInit & { duplex?: "half" } = { method, headers };
	if (init.body !== undefined) {
		req.body = init.body as BodyInit;
		if (init.body instanceof ReadableStream) req.duplex = "half";
	}
	if (init.signal !== undefined) req.signal = init.signal;
	const res = await h.app.request(new Request(`http://api.test${path}`, req));
	const rid = res.headers.get("request-id");
	if (rid === null || !REQUEST_ID_RE.test(rid)) {
		throw new Error(`${method} ${path} -> ${res.status}: no valid Request-Id`);
	}
	return res;
}

export async function bytesOf(res: Response): Promise<Buffer> {
	return Buffer.from(await res.arrayBuffer());
}

/** `/v1/sandboxes/<ref>/files<rest>` */
export function filesUrl(ref: string, rest = ""): string {
	return `/v1/sandboxes/${ref}/files${rest}`;
}

/** `?k=v&...` of the defined values. */
export function qs(
	params: Record<string, string | number | boolean | undefined>,
): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) q.set(k, String(v));
	}
	return `?${q.toString()}`;
}

/** One ustar entry (header and padded data). */
export function tarEntry(
	name: string,
	type: string,
	body = "",
	linkname = "",
	mode = 0o644,
): Buffer {
	const h = Buffer.alloc(512);
	h.write(name, 0, 100);
	h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
	h.write("00000000000\0", 136);
	h.write("        ", 148);
	h.write(type, 156);
	h.write(linkname, 157, 100);
	h.write("ustar\u000000", 257);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
	data.write(body);
	return Buffer.concat([h, data]);
}

/** A tar stream of the entries with the two end blocks. */
export function tarOf(...entries: Buffer[]): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/**
 * The world's FakeAgent with `files` replaced: `answer` returns a Response
 * to send instead, or undefined to call the fake. Other methods are the
 * fake's (bound: it has private fields).
 */
export function withFiles(
	w: ApiWorld,
	answer: (
		path: string,
		init: Parameters<AgentApi["files"]>[2],
	) => Response | undefined,
): AgentApi {
	return new Proxy(w.agent, {
		get(target, prop, receiver) {
			if (prop === "files") {
				return (
					m: string,
					path: string,
					init: Parameters<AgentApi["files"]>[2],
				) => Promise.resolve(answer(path, init) ?? target.files(m, path, init));
			}
			const v = Reflect.get(target, prop, receiver);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}
