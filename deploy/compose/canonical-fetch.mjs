// Node fetch rewrites Host to URL authority. Internal proxies need an explicit
// canonical Host while connecting to fixed Docker DNS, so use native HTTP here.
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export async function canonicalFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const transport =
		url.protocol === "http:" ? http : url.protocol === "https:" ? https : null;
	if (!transport) throw new TypeError("Unsupported upstream protocol");
	const body =
		request.body === null
			? undefined
			: Buffer.from(await request.arrayBuffer());
	return new Promise((resolve, reject) => {
		const upstream = transport.request(
			url,
			{
				method: request.method,
				headers: Object.fromEntries(request.headers),
				signal: request.signal,
			},
			(reply) => {
				const headers = new Headers();
				for (let i = 0; i < reply.rawHeaders.length; i += 2)
					headers.append(reply.rawHeaders[i], reply.rawHeaders[i + 1]);
				const status = reply.statusCode;
				const empty =
					request.method === "HEAD" || [204, 205, 304].includes(status);
				if (empty) reply.resume();
				resolve(
					new Response(empty ? null : Readable.toWeb(reply), {
						status,
						headers,
					}),
				);
			},
		);
		upstream.on("error", reject);
		upstream.end(body);
	});
}
