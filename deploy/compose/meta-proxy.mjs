// Bridge only anonymous deployment metadata across the web isolation boundary.
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function createMetaProxy(
	readMeta = () =>
		fetch("http://api:8080/v1/meta", {
			redirect: "error",
			signal: AbortSignal.timeout(3000),
		}),
) {
	return http.createServer(async (req, res) => {
		res.setHeader("cache-control", "no-store");
		if (req.method !== "GET" || req.url !== "/v1/meta") {
			res.writeHead(404);
			return res.end();
		}
		try {
			const upstream = await readMeta();
			if (!upstream.ok) throw new Error("metadata_unavailable");
			const meta = await upstream.json();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(meta));
		} catch {
			res.writeHead(503);
			res.end("metadata_unavailable");
		}
	});
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	createMetaProxy().listen(8080, "0.0.0.0");
